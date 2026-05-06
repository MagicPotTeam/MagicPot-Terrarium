import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  CANVAS_IMAGE_PROXY_DEFAULT_BATCH_MAX_SIDE,
  CANVAS_IMAGE_PROXY_HUGE_BATCH_MAX_SIDE,
  CANVAS_IMAGE_PROXY_LARGE_BATCH_MAX_SIDE,
  CANVAS_IMAGE_PROXY_MAX_SIDE,
  CANVAS_IMAGE_PROXY_MEDIUM_BATCH_MAX_SIDE,
  CANVAS_IMAGE_PROXY_SMALL_BATCH_MAX_SIDE,
  buildCanvasImageDisplayAsset,
  buildCanvasImagePlaceholderAsset,
  getCanvasImagePreviewMaxSideForBatch,
  hydrateCanvasImageItemForCanvas,
  loadImageFromSrc,
  readCanvasImageBlobMetadata
} from './canvasAssetIntakeHelpers'
import { isCanvasImageDeferredPlaceholderPreview } from './canvasImageAssetUtils'
import {
  buildCanvasImageSourceIdentity,
  canvasThumbnailManifestFromSet,
  createCanvasThumbnailSet
} from './canvasThumbnailCache'
import type { CanvasImageItem } from './types'

function createImage(width: number, height: number): HTMLImageElement {
  const image = document.createElement('img')
  Object.defineProperty(image, 'naturalWidth', { configurable: true, value: width })
  Object.defineProperty(image, 'naturalHeight', { configurable: true, value: height })
  Object.defineProperty(image, 'width', { configurable: true, value: width })
  Object.defineProperty(image, 'height', { configurable: true, value: height })
  return image
}

function createJpegMetadataBlob(width: number, height: number): Blob {
  return new Blob([
    new Uint8Array([
      0xff,
      0xd8,
      0xff,
      0xe0,
      0x00,
      0x10,
      ...Array.from({ length: 14 }, () => 0),
      0xff,
      0xc0,
      0x00,
      0x11,
      0x08,
      (height >> 8) & 0xff,
      height & 0xff,
      (width >> 8) & 0xff,
      width & 0xff,
      0x03,
      ...Array.from({ length: 9 }, () => 0)
    ])
  ])
}

function writeAscii(target: Uint8Array, offset: number, value: string) {
  for (let index = 0; index < value.length; index += 1) {
    target[offset + index] = value.charCodeAt(index)
  }
}

function writeWebpUint24(target: Uint8Array, offset: number, value: number) {
  target[offset] = value & 0xff
  target[offset + 1] = (value >> 8) & 0xff
  target[offset + 2] = (value >> 16) & 0xff
}

function createWebpV8xMetadataBlob(width: number, height: number, hasAlpha = false): Blob {
  const bytes = new Uint8Array(30)
  writeAscii(bytes, 0, 'RIFF')
  writeAscii(bytes, 8, 'WEBP')
  writeAscii(bytes, 12, 'VP8X')
  bytes[20] = hasAlpha ? 0x10 : 0
  writeWebpUint24(bytes, 24, width - 1)
  writeWebpUint24(bytes, 27, height - 1)
  return new Blob([bytes], { type: 'image/webp' })
}

describe('canvasAssetIntakeHelpers', () => {
  const originalImageCtor = window.Image
  const originalGetContext = HTMLCanvasElement.prototype.getContext
  const originalToBlob = HTMLCanvasElement.prototype.toBlob
  const originalToDataURL = HTMLCanvasElement.prototype.toDataURL
  const originalCreateObjectURL = URL.createObjectURL
  const originalCreateImageBitmap = globalThis.createImageBitmap
  const originalApi = window.api

  const nextLoadedWidth = 2048
  const nextLoadedHeight = 1024
  let lastMockImage: HTMLImageElement | null = null

  beforeEach(() => {
    lastMockImage = null
    window.Image = function MockImage() {
      const image = document.createElement('img')
      lastMockImage = image
      Object.defineProperty(image, 'naturalWidth', { configurable: true, value: nextLoadedWidth })
      Object.defineProperty(image, 'naturalHeight', {
        configurable: true,
        value: nextLoadedHeight
      })
      Object.defineProperty(image, 'width', { configurable: true, value: nextLoadedWidth })
      Object.defineProperty(image, 'height', { configurable: true, value: nextLoadedHeight })

      let currentSrc = ''
      Object.defineProperty(image, 'src', {
        configurable: true,
        get: () => currentSrc,
        set: (value: string) => {
          currentSrc = value
          queueMicrotask(() => image.onload?.(new Event('load')))
        }
      })

      return image
    } as unknown as typeof Image
  })

  afterEach(() => {
    window.Image = originalImageCtor
    URL.createObjectURL = originalCreateObjectURL
    Object.defineProperty(globalThis, 'createImageBitmap', {
      configurable: true,
      writable: true,
      value: originalCreateImageBitmap
    })
    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: originalApi
    })
    HTMLCanvasElement.prototype.getContext = originalGetContext
    HTMLCanvasElement.prototype.toBlob = originalToBlob
    HTMLCanvasElement.prototype.toDataURL = originalToDataURL
    vi.restoreAllMocks()
  })

  it('does not force CORS mode for local media image loads', async () => {
    await loadImageFromSrc('local-media:///C:/demo/reference.png')

    expect(lastMockImage?.crossOrigin).not.toBe('anonymous')
  })

  it('uses anonymous CORS for remote image loads', async () => {
    await loadImageFromSrc('https://example.test/reference.png')

    expect(lastMockImage?.crossOrigin).toBe('anonymous')
  })

  it('builds a scaled HTML image preview for large raster sources', async () => {
    const drawImage = vi.fn()
    HTMLCanvasElement.prototype.getContext = (() =>
      ({
        drawImage,
        imageSmoothingEnabled: false,
        imageSmoothingQuality: 'low'
      }) as unknown as CanvasRenderingContext2D) as unknown as typeof HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.toBlob = vi.fn((callback) => callback?.(null))
    HTMLCanvasElement.prototype.toDataURL = vi.fn(() => 'data:image/png;base64,preview')

    const originalImage = createImage(4096, 2048)
    const previewImage = await buildCanvasImageDisplayAsset({
      src: 'data:image/png;base64,AAAA',
      fileName: 'seedvr-output.png',
      originalImage,
      sourceWidth: 4096,
      sourceHeight: 2048
    })

    expect(drawImage).toHaveBeenCalledWith(originalImage, 0, 0, 2048, 1024)
    expect(previewImage).toBeInstanceOf(HTMLImageElement)
    expect(previewImage).not.toBe(originalImage)
    expect((previewImage as HTMLImageElement).naturalWidth).toBe(2048)
    expect((previewImage as HTMLImageElement).naturalHeight).toBe(1024)
  })

  it('allows large batch imports to request a lower-cost preview side', async () => {
    const drawImage = vi.fn()
    HTMLCanvasElement.prototype.getContext = (() =>
      ({
        drawImage,
        imageSmoothingEnabled: false,
        imageSmoothingQuality: 'low'
      }) as unknown as CanvasRenderingContext2D) as unknown as typeof HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.toBlob = vi.fn((callback) => callback?.(null))
    HTMLCanvasElement.prototype.toDataURL = vi.fn(() => 'data:image/png;base64,preview')

    const originalImage = createImage(4096, 2048)
    await buildCanvasImageDisplayAsset({
      src: 'data:image/png;base64,AAAA',
      fileName: 'seedvr-output.png',
      originalImage,
      sourceWidth: 4096,
      sourceHeight: 2048,
      maxPreviewSide: 256
    })

    expect(drawImage).toHaveBeenCalledWith(originalImage, 0, 0, 256, 128)
  })

  it('scales preview budgets down only for large batches', () => {
    expect(getCanvasImagePreviewMaxSideForBatch(1)).toBe(CANVAS_IMAGE_PROXY_MAX_SIDE)
    expect(getCanvasImagePreviewMaxSideForBatch(4)).toBe(CANVAS_IMAGE_PROXY_MAX_SIDE)
    expect(getCanvasImagePreviewMaxSideForBatch(5)).toBe(CANVAS_IMAGE_PROXY_SMALL_BATCH_MAX_SIDE)
    expect(getCanvasImagePreviewMaxSideForBatch(31)).toBe(CANVAS_IMAGE_PROXY_SMALL_BATCH_MAX_SIDE)
    expect(getCanvasImagePreviewMaxSideForBatch(32)).toBe(CANVAS_IMAGE_PROXY_DEFAULT_BATCH_MAX_SIDE)
    expect(getCanvasImagePreviewMaxSideForBatch(127)).toBe(
      CANVAS_IMAGE_PROXY_DEFAULT_BATCH_MAX_SIDE
    )
    expect(getCanvasImagePreviewMaxSideForBatch(128)).toBe(CANVAS_IMAGE_PROXY_MEDIUM_BATCH_MAX_SIDE)
    expect(getCanvasImagePreviewMaxSideForBatch(255)).toBe(CANVAS_IMAGE_PROXY_MEDIUM_BATCH_MAX_SIDE)
    expect(getCanvasImagePreviewMaxSideForBatch(256)).toBe(CANVAS_IMAGE_PROXY_LARGE_BATCH_MAX_SIDE)
    expect(getCanvasImagePreviewMaxSideForBatch(383)).toBe(CANVAS_IMAGE_PROXY_LARGE_BATCH_MAX_SIDE)
    expect(getCanvasImagePreviewMaxSideForBatch(384)).toBe(CANVAS_IMAGE_PROXY_HUGE_BATCH_MAX_SIDE)
    expect(getCanvasImagePreviewMaxSideForBatch(Number.NaN)).toBe(CANVAS_IMAGE_PROXY_MAX_SIDE)
  })

  it('marks generated deferred placeholder assets so selected WebGL images do not show them as previews', async () => {
    const placeholder = await buildCanvasImagePlaceholderAsset({ width: 512, height: 314 })

    expect(placeholder).not.toBeNull()
    expect(
      isCanvasImageDeferredPlaceholderPreview({
        image: placeholder ?? undefined,
        sourceWidth: 19717,
        sourceHeight: 12079,
        width: 19717,
        height: 12079
      })
    ).toBe(true)
  })

  it('reads JPEG image dimensions from headers without bitmap decoding', async () => {
    const createImageBitmapMock = vi.fn()
    Object.defineProperty(globalThis, 'createImageBitmap', {
      configurable: true,
      value: createImageBitmapMock
    })

    const metadata = await readCanvasImageBlobMetadata(createJpegMetadataBlob(3136, 1568))

    expect(metadata).toMatchObject({
      width: 3136,
      height: 1568,
      decodedByteSize: 3136 * 1568 * 4,
      hasAlpha: false
    })
    expect(createImageBitmapMock).not.toHaveBeenCalled()
  })

  it('reads WebP image dimensions from headers without bitmap decoding', async () => {
    const createImageBitmapMock = vi.fn()
    Object.defineProperty(globalThis, 'createImageBitmap', {
      configurable: true,
      value: createImageBitmapMock
    })

    const metadata = await readCanvasImageBlobMetadata(createWebpV8xMetadataBlob(2048, 1024, true))

    expect(metadata).toMatchObject({
      width: 2048,
      height: 1024,
      decodedByteSize: 2048 * 1024 * 4,
      hasAlpha: true
    })
    expect(createImageBitmapMock).not.toHaveBeenCalled()
  })

  it('falls back to the original image when preview rasterization is unavailable', async () => {
    HTMLCanvasElement.prototype.getContext = (() =>
      null) as unknown as typeof HTMLCanvasElement.prototype.getContext

    const originalImage = createImage(4096, 4096)
    const displayImage = await buildCanvasImageDisplayAsset({
      src: 'data:image/png;base64,AAAA',
      fileName: 'seedvr-output.png',
      originalImage,
      sourceWidth: 4096,
      sourceHeight: 4096
    })

    expect(displayImage).toBe(originalImage)
  })

  it('rehydrates generated images from Comfy metadata when the persisted project asset is missing', async () => {
    const recoveredBytes = new Uint8Array([1, 2, 3, 4])
    const getView = vi.fn(async () => ({ result: recoveredBytes }))
    const createObjectUrl = vi.fn(() => 'blob:recovered-comfy-image')
    URL.createObjectURL = createObjectUrl as unknown as typeof URL.createObjectURL

    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: {
        svcComfy: {
          getView
        }
      }
    })

    const loadedImage = createImage(640, 360)
    const loadImageFromSrc = vi.fn(async (src: string) => {
      if (src === 'local-media:///C:/missing/assets/generated.png') {
        throw new Error('missing asset')
      }

      return {
        img: loadedImage,
        width: 640,
        height: 360
      }
    })

    const item: CanvasImageItem = {
      id: 'image-generated-1',
      type: 'image',
      src: 'local-media:///C:/missing/assets/generated.png',
      fileName: 'generated.png',
      fileItem: {
        filename: 'generated.png',
        type: 'output'
      },
      x: 0,
      y: 0,
      width: 320,
      height: 180,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      zIndex: 1,
      locked: false,
      hasAlpha: true
    }

    const hydrated = await hydrateCanvasImageItemForCanvas({ item, loadImageFromSrc })

    expect(getView).toHaveBeenCalledWith(item.fileItem)
    expect(createObjectUrl).toHaveBeenCalled()
    expect(loadImageFromSrc).toHaveBeenNthCalledWith(
      1,
      'local-media:///C:/missing/assets/generated.png'
    )
    expect(loadImageFromSrc).toHaveBeenNthCalledWith(2, 'blob:recovered-comfy-image')
    expect(hydrated).toMatchObject({
      id: 'image-generated-1',
      src: 'blob:recovered-comfy-image',
      sourceWidth: 640,
      sourceHeight: 360
    })
  })

  it('rehydrates local images from warm thumbnail cache without loading the source image', async () => {
    const sourceIdentity = buildCanvasImageSourceIdentity({
      canonicalPath: 'C:/assets/reference.png',
      sizeBytes: 4096,
      lastModifiedMs: 123456
    })
    expect(sourceIdentity).not.toBeNull()

    const thumbnailSet = createCanvasThumbnailSet({
      identity: sourceIdentity!,
      levels: [
        {
          maxSide: 128,
          src: 'local-media:///cache/reference/128.webp',
          filename: '128.webp',
          mimeType: 'image/webp',
          width: 128,
          height: 64,
          sizeBytes: 128
        },
        {
          maxSide: 256,
          src: 'local-media:///cache/reference/256.webp',
          filename: '256.webp',
          mimeType: 'image/webp',
          width: 256,
          height: 128,
          sizeBytes: 256
        },
        {
          maxSide: 512,
          src: 'local-media:///cache/reference/512.webp',
          filename: '512.webp',
          mimeType: 'image/webp',
          width: 512,
          height: 256,
          sizeBytes: 512
        },
        {
          maxSide: 1024,
          src: 'local-media:///cache/reference/1024.webp',
          filename: '1024.webp',
          mimeType: 'image/webp',
          width: 1024,
          height: 512,
          sizeBytes: 1024
        },
        {
          maxSide: 2048,
          src: 'local-media:///cache/reference/2048.webp',
          filename: '2048.webp',
          mimeType: 'image/webp',
          width: 2048,
          height: 1024,
          sizeBytes: 2048
        }
      ],
      now: new Date('2026-05-02T00:00:00.000Z')
    })

    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: {
        svcCanvasThumbnail: {
          readThumbnailManifest: vi.fn(async () => ({
            manifest: canvasThumbnailManifestFromSet(thumbnailSet)
          }))
        }
      }
    })

    const thumbnailImage = createImage(512, 256)
    const loadImageFromSrc = vi.fn(async (src: string) => {
      if (src === 'local-media:///cache/reference/512.webp') {
        return {
          img: thumbnailImage,
          width: 512,
          height: 256
        }
      }

      throw new Error(`Unexpected source load: ${src}`)
    })

    const item: CanvasImageItem = {
      id: 'image-reference-1',
      type: 'image',
      src: 'local-media:///C:/assets/reference.png',
      fileName: 'reference.png',
      sourceIdentity: sourceIdentity!,
      x: 0,
      y: 0,
      width: 1024,
      height: 512,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      zIndex: 1,
      locked: false,
      sourceWidth: 4096,
      sourceHeight: 2048
    }

    const hydrated = await hydrateCanvasImageItemForCanvas({ item, loadImageFromSrc })

    expect(loadImageFromSrc).toHaveBeenCalledTimes(1)
    expect(loadImageFromSrc).toHaveBeenCalledWith('local-media:///cache/reference/512.webp')
    expect(hydrated).toMatchObject({
      id: 'image-reference-1',
      src: 'local-media:///C:/assets/reference.png',
      image: thumbnailImage,
      thumbnailSet
    })
  })
})
