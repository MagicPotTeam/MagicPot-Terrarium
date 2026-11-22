import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  CANVAS_IMAGE_PROXY_DEFAULT_BATCH_MAX_SIDE,
  CANVAS_IMAGE_PROXY_HUGE_BATCH_MAX_SIDE,
  CANVAS_IMAGE_PROXY_LARGE_BATCH_MAX_SIDE,
  CANVAS_IMAGE_PROXY_MAX_SIDE,
  CANVAS_IMAGE_PROXY_MEDIUM_BATCH_MAX_SIDE,
  CANVAS_IMAGE_PROXY_SMALL_BATCH_MAX_SIDE,
  bindCanvasThumbnailSetToSource,
  buildCanvasImageDisplayAsset,
  buildCanvasImagePlaceholderAsset,
  createCanvasImagePendingPixelsAsset,
  getCanvasImagePreviewMaxSideForBatch,
  getCanvasThumbnailHydrationGenerationConcurrency,
  hydrateCanvasImageItemForCanvas,
  isCanvasImagePendingPixelsAsset,
  loadImageFromSrc,
  readCanvasImageBlobMetadata,
  resolveCanvasImageThumbnailDisplayAsset
} from './canvasAssetIntakeHelpers'
import {
  getCanvasImageAssetSize,
  isCanvasImageDeferredPlaceholderPreview,
  isCanvasImagePlaceholderAsset
} from './canvasImageAssetUtils'
import { resolveCanvasImageLodDecision } from './canvasImageLodPolicy'
import {
  buildCanvasImageSourceIdentity,
  buildCanvasSessionSourceIdentity,
  canvasThumbnailManifestFromSet,
  createCanvasThumbnailSet,
  isCanvasThumbnailSetFresh
} from './canvasThumbnailCache'
import { resetCanvasThumbnailWorkerPoolForTest } from './canvasThumbnailWorkerClient'
import type { CanvasImageThumbnailLevel, CanvasThumbnailLevelSize } from './canvasThumbnailTypes'
import type { CanvasImageAsset, CanvasImageItem } from './types'

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
  const originalRevokeObjectURL = URL.revokeObjectURL
  const originalCreateImageBitmap = globalThis.createImageBitmap
  const originalApi = window.api
  const originalElectronFile = window.electronFile

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
    URL.revokeObjectURL = originalRevokeObjectURL
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
    Object.defineProperty(window, 'electronFile', {
      configurable: true,
      writable: true,
      value: originalElectronFile
    })
    HTMLCanvasElement.prototype.getContext = originalGetContext
    HTMLCanvasElement.prototype.toBlob = originalToBlob
    HTMLCanvasElement.prototype.toDataURL = originalToDataURL
    vi.restoreAllMocks()
  })

  it('uses anonymous CORS mode for local media image loads', async () => {
    await loadImageFromSrc('local-media:///C:/demo/reference.png')

    expect(lastMockImage?.crossOrigin).toBe('anonymous')
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

  it('loads dropped local-media images through an authorized protocol URL', async () => {
    const loadedSources: string[] = []
    window.Image = function MockImage() {
      const image = createImage(640, 360)
      let currentSrc = ''
      Object.defineProperty(image, 'src', {
        configurable: true,
        get: () => currentSrc,
        set: (value: string) => {
          currentSrc = value
          loadedSources.push(value)
          queueMicrotask(() => image.onload?.(new Event('load')))
        }
      })

      return image
    } as unknown as typeof Image

    const resolveAuthorizedLocalMediaPath = vi.fn(async (filePath: string) => filePath)

    Object.defineProperty(window, 'electronFile', {
      configurable: true,
      writable: true,
      value: {
        resolveAuthorizedLocalMediaPath
      }
    })

    const loaded = await loadImageFromSrc('local-media:///C:/assets/reference.png')

    expect(resolveAuthorizedLocalMediaPath).toHaveBeenCalledWith('C:/assets/reference.png')
    expect(loadedSources).toEqual(['local-media:///C:/assets/reference.png'])
    expect(loaded).toMatchObject({
      width: 640,
      height: 360
    })
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

  it('swaps the header size of a JPEG that its EXIF orientation turns by a quarter', async () => {
    const createImageBitmapMock = vi.fn(async () => {
      throw new Error('bitmap decode should not be used for JPEG metadata')
    })
    Object.defineProperty(globalThis, 'createImageBitmap', {
      configurable: true,
      writable: true,
      value: createImageBitmapMock
    })
    /** SOI, an APP1 EXIF segment with only the orientation tag, then SOF0 with the stored size. */
    const createJpegWithExif = (
      storedWidth: number,
      storedHeight: number,
      orientation: number,
      littleEndian: boolean
    ) => {
      const u16 = (value: number) =>
        littleEndian ? [value & 0xff, value >> 8] : [value >> 8, value & 0xff]
      const u32 = (value: number) =>
        littleEndian ? [value & 0xff, 0, 0, 0] : [0, 0, 0, value & 0xff]
      const tiff = [
        ...(littleEndian ? [0x49, 0x49] : [0x4d, 0x4d]),
        ...u16(42),
        ...u32(8),
        ...u16(1),
        ...u16(0x0112),
        ...u16(3),
        ...u32(1),
        ...u16(orientation),
        0,
        0,
        ...u32(0)
      ]
      const exif = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff]
      const app1Length = exif.length + 2
      return new Blob([
        new Uint8Array([
          0xff,
          0xd8,
          0xff,
          0xe1,
          app1Length >> 8,
          app1Length & 0xff,
          ...exif,
          0xff,
          0xc0,
          0x00,
          0x11,
          0x08,
          (storedHeight >> 8) & 0xff,
          storedHeight & 0xff,
          (storedWidth >> 8) & 0xff,
          storedWidth & 0xff,
          0x03,
          ...Array.from({ length: 9 }, () => 0)
        ])
      ])
    }
    const sizeOf = async (orientation: number, littleEndian = false) => {
      const metadata = await readCanvasImageBlobMetadata(
        createJpegWithExif(1600, 1000, orientation, littleEndian)
      )
      return [metadata?.width, metadata?.height]
    }

    // 1-4 keep the stored size (mirrored or turned by a half), 5-8 are shown as 1000 x 1600.
    for (const orientation of [1, 2, 3, 4]) {
      expect(await sizeOf(orientation)).toEqual([1600, 1000])
    }
    for (const orientation of [5, 6, 7, 8]) {
      expect(await sizeOf(orientation)).toEqual([1000, 1600])
      expect(await sizeOf(orientation, true)).toEqual([1000, 1600])
    }
    // A value outside 1-8 is ignored.
    expect(await sizeOf(9)).toEqual([1600, 1000])
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

  it('rehydrates persisted local images through an authorized protocol fetch', async () => {
    const resolveAuthorizedLocalMediaPath = vi.fn(async (filePath: string) => filePath)
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      blob: async () => new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/png' })
    } as Response)
    const createObjectUrl = vi.fn(() => 'blob:recovered-local-image')
    const revokeObjectUrl = vi.fn()
    URL.createObjectURL = createObjectUrl as unknown as typeof URL.createObjectURL
    URL.revokeObjectURL = revokeObjectUrl as unknown as typeof URL.revokeObjectURL

    Object.defineProperty(window, 'electronFile', {
      configurable: true,
      writable: true,
      value: {
        resolveAuthorizedLocalMediaPath
      }
    })

    const loadedImage = createImage(640, 360)
    const loadImageFromSrc = vi.fn(async (src: string) => {
      if (src === 'local-media:///C:/assets/reference.png') {
        throw new Error('blocked local-media')
      }
      if (src === 'blob:recovered-local-image') {
        return {
          img: loadedImage,
          width: 640,
          height: 360
        }
      }

      throw new Error(`Unexpected source load: ${src}`)
    })

    const item: CanvasImageItem = {
      id: 'image-local-1',
      type: 'image',
      src: 'local-media:///C:/assets/reference.png',
      fileName: 'reference.png',
      x: 0,
      y: 0,
      width: 320,
      height: 180,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      zIndex: 1,
      locked: false,
      hasAlpha: false,
      sizeBytes: 4
    }

    const hydrated = await hydrateCanvasImageItemForCanvas({
      item,
      loadImageFromSrc,
      maxPreviewSide: CANVAS_IMAGE_PROXY_MAX_SIDE
    })

    expect(resolveAuthorizedLocalMediaPath).toHaveBeenCalledWith('C:/assets/reference.png')
    expect(fetchMock).toHaveBeenCalledWith('local-media:///C:/assets/reference.png', {
      signal: undefined
    })
    expect(loadImageFromSrc).toHaveBeenNthCalledWith(1, 'local-media:///C:/assets/reference.png')
    expect(loadImageFromSrc).toHaveBeenNthCalledWith(2, 'blob:recovered-local-image')
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:recovered-local-image')
    expect(hydrated).toMatchObject({
      id: 'image-local-1',
      src: 'local-media:///C:/assets/reference.png',
      image: loadedImage,
      sourceWidth: 640,
      sourceHeight: 360
    })
  })

  it.each([false, true])('does not invent crop source dimensions from displayed bounds, known=%s', async (known) => {
    const sourceIdentity = buildCanvasImageSourceIdentity({ canonicalPath: 'C:/synthetic/original.png', sizeBytes: 123, lastModifiedMs: 1 })!
    const thumbnailSet = createCanvasThumbnailSet({
      identity: sourceIdentity,
      levels: ([128, 256, 512, 1024, 2048] as const).map((maxSide) => ({ maxSide, src: 'data:image/png;base64,c3ludGhldGljLXRodW1ibmFpbA==', filename: `${maxSide}.png`, mimeType: 'image/png' as const, width: 100, height: 100, sizeBytes: 10 })),
      now: new Date('2026-05-02T00:00:00.000Z')
    })
    // Source dimensions are a synthetic fixture assumption; no source decode or network occurs.
    const sourceUrl = 'data:image/png;base64,c3ludGhldGljLTIwMHgyMDA='
    const thumbnailImage = createImage(100, 100)
    const loadImageFromSrc = vi.fn(async (src: string) => {
      if (src !== thumbnailSet.levels[0].src) throw new Error('unexpected original source load')
      return { img: thumbnailImage, width: 100, height: 100 }
    })
    const item: CanvasImageItem = {
      id: 'synthetic-crop', type: 'image', src: sourceUrl, sourceIdentity, thumbnailSet,
      x: 0, y: 0, width: 100, height: 100, rotation: 0, scaleX: 1, scaleY: 1,
      zIndex: 1, locked: false, crop: { x: 0, y: 0, width: 100, height: 100 },
      ...(known ? { sourceWidth: 200, sourceHeight: 200 } : {})
    }
    const hydrated = await hydrateCanvasImageItemForCanvas({ item, loadImageFromSrc })
    expect(loadImageFromSrc).toHaveBeenCalledOnce()
    expect(hydrated?.image).toBe(thumbnailImage)
    expect(hydrated?.crop).toEqual(item.crop)
    expect(hydrated?.sourceWidth).toBe(known ? 200 : undefined)
    expect(hydrated?.sourceHeight).toBe(known ? 200 : undefined)
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

  it('recovers warm thumbnail previews through an authorized protocol fetch', async () => {
    const sourceIdentity = buildCanvasImageSourceIdentity({
      canonicalPath: 'C:/assets/reference.png',
      sizeBytes: 4096,
      lastModifiedMs: 123456
    })
    expect(sourceIdentity).not.toBeNull()

    const thumbnailSet = createCanvasThumbnailSet({
      identity: sourceIdentity!,
      levels: ([128, 256, 512, 1024, 2048] as const).map((maxSide) => ({
        maxSide,
        src: `local-media:///cache/reference/${maxSide}.webp`,
        filename: `${maxSide}.webp`,
        mimeType: 'image/webp',
        width: maxSide,
        height: maxSide / 2,
        sizeBytes: maxSide
      })),
      now: new Date('2026-05-02T00:00:00.000Z')
    })
    const resolveAuthorizedLocalMediaPath = vi.fn(async (filePath: string) => filePath)
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      blob: async () => new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/webp' })
    } as Response)
    const createObjectUrl = vi.fn(() => 'blob:recovered-thumbnail')
    const revokeObjectUrl = vi.fn()
    URL.createObjectURL = createObjectUrl as unknown as typeof URL.createObjectURL
    URL.revokeObjectURL = revokeObjectUrl as unknown as typeof URL.revokeObjectURL

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
    Object.defineProperty(window, 'electronFile', {
      configurable: true,
      writable: true,
      value: {
        resolveAuthorizedLocalMediaPath
      }
    })

    const thumbnailImage = createImage(512, 256)
    const loadImageFromSrc = vi.fn(async (src: string) => {
      if (src === 'local-media:///cache/reference/512.webp') {
        throw new Error('blocked thumbnail')
      }
      if (src === 'blob:recovered-thumbnail') {
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

    expect(resolveAuthorizedLocalMediaPath).toHaveBeenCalledWith('/cache/reference/512.webp')
    expect(fetchMock).toHaveBeenCalledWith('local-media:///cache/reference/512.webp', {
      signal: undefined
    })
    expect(loadImageFromSrc).toHaveBeenNthCalledWith(1, 'local-media:///cache/reference/512.webp')
    expect(loadImageFromSrc).toHaveBeenNthCalledWith(2, 'blob:recovered-thumbnail')
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:recovered-thumbnail')
    expect(hydrated).toMatchObject({
      id: 'image-reference-1',
      src: 'local-media:///C:/assets/reference.png',
      image: thumbnailImage,
      thumbnailSet
    })
  })

  describe('thumbnail sets whose top levels are the source itself', () => {
    const sourceSrc = 'local-media:///C:/assets/small.png'
    const createSourceIdentity = () =>
      buildCanvasImageSourceIdentity({
        canonicalPath: 'C:/assets/small.png',
        sizeBytes: 4096,
        lastModifiedMs: 123456
      })!
    const fileLevel = (
      maxSide: CanvasThumbnailLevelSize,
      fileSide: number
    ): CanvasImageThumbnailLevel => ({
      maxSide,
      src: `local-media:///cache/small/${fileSide}.webp`,
      filename: `${fileSide}.webp`,
      mimeType: 'image/webp',
      width: fileSide,
      height: Math.round(fileSide * 0.75),
      sizeBytes: fileSide * 10
    })
    /** A 1024 x 768 source: files for 128, 256 and 512; 1024 and 2048 repeat the 512 file. */
    const createSetOfSmallSource = () =>
      createCanvasThumbnailSet({
        identity: createSourceIdentity(),
        levels: [
          fileLevel(128, 128),
          fileLevel(256, 256),
          fileLevel(512, 512),
          fileLevel(1024, 512),
          fileLevel(2048, 512)
        ]
      })

    it('points the levels without a file of their own at the source', () => {
      const thumbnailSet = createSetOfSmallSource()
      const bound = bindCanvasThumbnailSetToSource(thumbnailSet, {
        src: sourceSrc,
        sourceWidth: 1024,
        sourceHeight: 768,
        sizeBytes: 4096
      })

      expect(
        bound.levels.map((level) => [level.maxSide, level.src, level.width, level.height])
      ).toEqual([
        [128, 'local-media:///cache/small/128.webp', 128, 96],
        [256, 'local-media:///cache/small/256.webp', 256, 192],
        [512, 'local-media:///cache/small/512.webp', 512, 384],
        [1024, sourceSrc, 1024, 768],
        [2048, sourceSrc, 1024, 768]
      ])
      expect(bound.levels[3].sizeBytes).toBe(4096)
      // Still a complete, fresh set for the renderer, and binding twice changes nothing.
      expect(isCanvasThumbnailSetFresh(bound, createSourceIdentity())).toBe(true)
      expect(bindCanvasThumbnailSetToSource(bound, { src: sourceSrc })).toBe(bound)
      // The stored set is not touched.
      expect(thumbnailSet.levels[4].src).toBe('local-media:///cache/small/512.webp')
    })

    it('sizes a source-backed level like the level it stands for when the source size is unknown', () => {
      const bound = bindCanvasThumbnailSetToSource(createSetOfSmallSource(), { src: sourceSrc })
      expect(
        bound.levels.slice(3).map((level) => [level.maxSide, level.width, level.height])
      ).toEqual([
        [1024, 1024, 768],
        [2048, 2048, 1536]
      ])
    })

    it('leaves a set with one file per level as it is', () => {
      const thumbnailSet = createCanvasThumbnailSet({
        identity: createSourceIdentity(),
        levels: ([128, 256, 512, 1024, 2048] as const).map((side) => fileLevel(side, side))
      })
      expect(
        bindCanvasThumbnailSetToSource(thumbnailSet, {
          src: sourceSrc,
          sourceWidth: 4096,
          sourceHeight: 3072
        })
      ).toBe(thumbnailSet)
    })

    it('shows the source for a small import of a small image and the 512 file for a large batch', async () => {
      const thumbnailSet = createSetOfSmallSource()
      const readThumbnailManifest = vi.fn(async () => ({
        manifest: canvasThumbnailManifestFromSet(thumbnailSet)
      }))
      Object.defineProperty(window, 'api', {
        configurable: true,
        writable: true,
        value: { svcCanvasThumbnail: { readThumbnailManifest } }
      })
      const loaded: string[] = []
      const loadImageFromSrcFn = vi.fn(async (src: string) => {
        loaded.push(src)
        return { img: createImage(1, 1), width: 1, height: 1 }
      })
      const resolve = (maxPreviewSide: number) =>
        resolveCanvasImageThumbnailDisplayAsset({
          src: sourceSrc,
          sourceIdentity: createSourceIdentity(),
          sourceWidth: 1024,
          sourceHeight: 768,
          maxPreviewSide,
          loadImageFromSrcFn
        })

      // 1-4 images at once ask for 2048 px: for a 1024 px source that is the source.
      const single = await resolve(CANVAS_IMAGE_PROXY_MAX_SIDE)
      // 32 and more ask for 512 px: that level has a file.
      const batch = await resolve(CANVAS_IMAGE_PROXY_DEFAULT_BATCH_MAX_SIDE)

      expect(loaded).toEqual([sourceSrc, 'local-media:///cache/small/512.webp'])
      for (const result of [single, batch]) {
        expect(result?.thumbnailSet.levels.map((level) => level.src)).toEqual([
          'local-media:///cache/small/128.webp',
          'local-media:///cache/small/256.webp',
          'local-media:///cache/small/512.webp',
          sourceSrc,
          sourceSrc
        ])
      }
    })

    const installLevelGenerationMocks = (sourceWidth: number, sourceHeight: number) => {
      // No Worker in this environment: the levels are made in scope, with the same code.
      const createImageBitmapMock = vi.fn(async () => ({
        width: sourceWidth,
        height: sourceHeight,
        close: vi.fn()
      }))
      Object.defineProperty(globalThis, 'createImageBitmap', {
        configurable: true,
        writable: true,
        value: createImageBitmapMock
      })
      HTMLCanvasElement.prototype.getContext = (() =>
        ({
          clearRect: vi.fn(),
          drawImage: vi.fn(),
          imageSmoothingEnabled: false,
          imageSmoothingQuality: 'low'
        }) as unknown as CanvasRenderingContext2D) as unknown as typeof HTMLCanvasElement.prototype.getContext
      const pendingEncodes: Array<{ width: number; finish: () => void }> = []
      HTMLCanvasElement.prototype.toBlob = vi.fn(function (
        this: HTMLCanvasElement,
        callback: BlobCallback
      ) {
        const width = this.width
        pendingEncodes.push({
          width,
          finish: () => callback(new Blob([`level-${width}`], { type: 'image/webp' }))
        })
      }) as unknown as typeof HTMLCanvasElement.prototype.toBlob
      return { createImageBitmapMock, pendingEncodes }
    }

    it('reads the cache once and shows the display level of a cold large image before the larger levels are encoded', async () => {
      resetCanvasThumbnailWorkerPoolForTest()
      const identity = createSourceIdentity()
      const readThumbnailManifest = vi.fn(async () => ({ manifest: null }))
      const writeThumbnailSet = vi.fn(
        async ({ manifest }: { manifest: ReturnType<typeof canvasThumbnailManifestFromSet> }) => ({
          manifest: {
            ...manifest,
            levels: manifest.levels.map((level) => ({
              ...level,
              src: `local-media:///cache/large/${level.filename}`
            }))
          }
        })
      )
      Object.defineProperty(window, 'api', {
        configurable: true,
        writable: true,
        value: { svcCanvasThumbnail: { readThumbnailManifest, writeThumbnailSet } }
      })
      const { createImageBitmapMock, pendingEncodes } = installLevelGenerationMocks(4096, 3072)
      const order: string[] = []
      const firstImages: CanvasImageAsset[] = []
      const levelImage = createImage(512, 384)
      let nextUrl = 0
      URL.createObjectURL = vi.fn(() => `blob:level-${++nextUrl}`)
      URL.revokeObjectURL = vi.fn()

      const resolving = resolveCanvasImageThumbnailDisplayAsset({
        src: 'local-media:///C:/assets/large.png',
        sourceIdentity: identity,
        sourceFile: new Blob(['large-source'], { type: 'image/png' }),
        sourceWidth: 4096,
        sourceHeight: 3072,
        maxPreviewSide: CANVAS_IMAGE_PROXY_DEFAULT_BATCH_MAX_SIDE,
        onFirstImage: (image) => {
          order.push('first-image')
          firstImages.push(image)
        },
        loadImageFromSrcFn: async (src) => {
          order.push(`load ${src}`)
          return { img: levelImage, width: 512, height: 384 }
        }
      })

      // The 512 level is encoded first and shown at once: four encodes are still to come.
      await vi.waitFor(() => expect(pendingEncodes).toHaveLength(1))
      expect(pendingEncodes[0].width).toBe(512)
      pendingEncodes.shift()?.finish()
      await vi.waitFor(() => expect(firstImages).toHaveLength(1))
      expect(order).toEqual(['load blob:level-1', 'first-image'])
      expect(firstImages[0]).toBe(levelImage)
      // Real pixels, not a placeholder: nothing has to replace this image later.
      expect(isCanvasImagePlaceholderAsset(firstImages[0])).toBe(false)
      expect(writeThumbnailSet).not.toHaveBeenCalled()

      for (let index = 0; index < 4; index += 1) {
        await vi.waitFor(() => expect(pendingEncodes).toHaveLength(1))
        pendingEncodes.shift()?.finish()
      }
      const result = await resolving

      expect(readThumbnailManifest).toHaveBeenCalledTimes(1)
      expect(writeThumbnailSet).toHaveBeenCalledTimes(1)
      // The same image element: the canvas uploads it once. No read of the file just written.
      expect(result?.image).toBe(levelImage)
      expect(order).toEqual(['load blob:level-1', 'first-image'])
      expect(firstImages).toHaveLength(1)
      expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:level-1')
      // One decode of the source, no second bitmap for the early image.
      expect(createImageBitmapMock).toHaveBeenCalledTimes(1)
      // A 4096 px source has a file for every level: nothing points at the source.
      expect(new Set(result?.thumbnailSet.levels.map((level) => level.src)).size).toBe(5)
    })

    it('shows the freshly encoded level of a small source from its bytes, without an early hand-over', async () => {
      resetCanvasThumbnailWorkerPoolForTest()
      const writeThumbnailSet = vi.fn(
        async ({ manifest }: { manifest: ReturnType<typeof canvasThumbnailManifestFromSet> }) => ({
          manifest: {
            ...manifest,
            levels: manifest.levels.map((level) => ({
              ...level,
              src: `local-media:///cache/small/${level.filename}`
            }))
          }
        })
      )
      Object.defineProperty(window, 'api', {
        configurable: true,
        writable: true,
        value: {
          svcCanvasThumbnail: {
            readThumbnailManifest: vi.fn(async () => ({ manifest: null })),
            writeThumbnailSet
          }
        }
      })
      const { createImageBitmapMock, pendingEncodes } = installLevelGenerationMocks(1024, 768)
      URL.createObjectURL = vi.fn(() => 'blob:generated-512')
      URL.revokeObjectURL = vi.fn()
      const onFirstImage = vi.fn()
      const loaded: string[] = []

      const resolving = resolveCanvasImageThumbnailDisplayAsset({
        src: sourceSrc,
        sourceIdentity: createSourceIdentity(),
        sourceFile: new Blob(['small-source'], { type: 'image/png' }),
        sourceWidth: 1024,
        sourceHeight: 768,
        maxPreviewSide: CANVAS_IMAGE_PROXY_DEFAULT_BATCH_MAX_SIDE,
        onFirstImage,
        loadImageFromSrcFn: async (src) => {
          loaded.push(src)
          return { img: createImage(512, 384), width: 512, height: 384 }
        }
      })
      // 128, 256 and 512: smallest first, the 512 level is the last encode of the job.
      for (const width of [128, 256, 512]) {
        await vi.waitFor(() => expect(pendingEncodes).toHaveLength(1))
        expect(pendingEncodes[0].width).toBe(width)
        pendingEncodes.shift()?.finish()
      }
      const result = await resolving

      expect(result).not.toBeNull()
      expect(onFirstImage).not.toHaveBeenCalled()
      expect(createImageBitmapMock).toHaveBeenCalledTimes(1)
      // Shown from the bytes that were just encoded, not read back through local-media.
      expect(loaded).toEqual(['blob:generated-512'])
      const writtenLevels = writeThumbnailSet.mock.calls[0][0].manifest.levels
      expect(writtenLevels.map((level) => level.filename)).toEqual([
        '128.webp',
        '256.webp',
        '512.webp',
        '512.webp',
        '512.webp'
      ])
      expect(result?.thumbnailSet.levels.map((level) => level.src)).toEqual([
        'local-media:///cache/small/128.webp',
        'local-media:///cache/small/256.webp',
        'local-media:///cache/small/512.webp',
        sourceSrc,
        sourceSrc
      ])
    })

    it('shows the source itself for an image smaller than the display level', async () => {
      resetCanvasThumbnailWorkerPoolForTest()
      Object.defineProperty(window, 'api', {
        configurable: true,
        writable: true,
        value: {
          svcCanvasThumbnail: { readThumbnailManifest: vi.fn(async () => ({ manifest: null })) }
        }
      })
      const { pendingEncodes } = installLevelGenerationMocks(300, 200)
      let nextUrl = 0
      URL.createObjectURL = vi.fn(() => `blob:transient-${++nextUrl}`)
      URL.revokeObjectURL = vi.fn()
      const onFirstImage = vi.fn()
      const loaded: string[] = []
      const tinySrc = 'blob:pasted-tiny'
      const identity = buildCanvasSessionSourceIdentity({
        sourceKey: 'canvas-session:tiny',
        sizeBytes: 900,
        mimeType: 'image/png',
        fileName: 'tiny.png'
      })

      const resolving = resolveCanvasImageThumbnailDisplayAsset({
        src: tinySrc,
        sourceIdentity: identity,
        sourceFile: new Blob(['tiny-source'], { type: 'image/png' }),
        sourceWidth: 300,
        sourceHeight: 200,
        maxPreviewSide: CANVAS_IMAGE_PROXY_DEFAULT_BATCH_MAX_SIDE,
        onFirstImage,
        loadImageFromSrcFn: async (src) => {
          loaded.push(src)
          return { img: createImage(300, 200), width: 300, height: 200 }
        }
      })
      // A 300 px image gets the 128 and 256 files only.
      for (const width of [128, 256]) {
        await vi.waitFor(() => expect(pendingEncodes).toHaveLength(1))
        expect(pendingEncodes[0].width).toBe(width)
        pendingEncodes.shift()?.finish()
      }
      const result = await resolving

      expect(onFirstImage).not.toHaveBeenCalled()
      // 512 px was asked for: that is the source's own 300 px, not an enlarged 256 px file.
      expect(loaded).toEqual([tinySrc])
      expect(
        result?.thumbnailSet.levels.map((level) => [level.maxSide, level.width, level.height])
      ).toEqual([
        [128, 128, 85],
        [256, 256, 171],
        [512, 300, 200],
        [1024, 300, 200],
        [2048, 300, 200]
      ])
      expect(result?.thumbnailSet.levels.slice(2).every((level) => level.src === tinySrc)).toBe(
        true
      )
      expect(isCanvasThumbnailSetFresh(result?.thumbnailSet, identity)).toBe(true)
    })
  })

  it('opens a board of uncached images a few thumbnail generations at a time', async () => {
    resetCanvasThumbnailWorkerPoolForTest()
    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: {
        svcCanvasThumbnail: { readThumbnailManifest: vi.fn(async () => ({ manifest: null })) }
      }
    })
    // Each generation starts by reading its source: hold every read.
    const pendingReads: Array<() => void> = []
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          pendingReads.push(() => resolve({ ok: false, status: 404 } as Response))
        })
    )
    vi.stubGlobal('fetch', fetchMock)
    const loadImageFromSrc = vi.fn(async () => ({
      img: createImage(64, 48),
      width: 64,
      height: 48
    }))
    const items: CanvasImageItem[] = Array.from({ length: 20 }, (_, index) => ({
      id: `reopened-${index}`,
      type: 'image',
      src: `local-media:///C:/board/reopened-${index}.png`,
      x: 0,
      y: 0,
      width: 320,
      height: 240,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      zIndex: 1,
      locked: false,
      sourceIdentity: buildCanvasImageSourceIdentity({
        canonicalPath: `C:/board/reopened-${index}.png`,
        sizeBytes: 1000 + index,
        lastModifiedMs: 1700000000000
      })!
    }))

    try {
      const hydrations = items.map((item) =>
        hydrateCanvasImageItemForCanvas({ item, loadImageFromSrc })
      )
      const limit = getCanvasThumbnailHydrationGenerationConcurrency()
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(limit))
      await new Promise((resolve) => setTimeout(resolve, 20))
      // The others wait in turn instead of all reading their source (and later generating) at once.
      expect(fetchMock).toHaveBeenCalledTimes(limit)

      for (let round = 0; round < 40 && fetchMock.mock.calls.length < items.length; round += 1) {
        pendingReads.splice(0).forEach((finish) => finish())
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      pendingReads.splice(0).forEach((finish) => finish())
      const hydrated = await Promise.all(hydrations)
      expect(fetchMock).toHaveBeenCalledTimes(items.length)
      expect(hydrated.every((item) => item?.image)).toBe(true)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('makes one flat pending tile per import and marks it as a placeholder', () => {
    HTMLCanvasElement.prototype.getContext = (() =>
      null) as typeof HTMLCanvasElement.prototype.getContext
    const first = createCanvasImagePendingPixelsAsset()
    const second = createCanvasImagePendingPixelsAsset()

    expect(first).not.toBeNull()
    // Each import tells its own waiting frames apart by the tile object.
    expect(second).not.toBe(first)
    expect(isCanvasImagePendingPixelsAsset(first)).toBe(true)
    expect(isCanvasImagePendingPixelsAsset(second)).toBe(true)
    expect(isCanvasImagePlaceholderAsset(first)).toBe(true)
    expect(isCanvasImagePendingPixelsAsset(document.createElement('canvas'))).toBe(false)
    expect(isCanvasImagePendingPixelsAsset(undefined)).toBe(false)
  })

  it('keeps the pending tile cheap as a texture and quiet for the renderer', () => {
    HTMLCanvasElement.prototype.getContext = (() =>
      null) as typeof HTMLCanvasElement.prototype.getContext
    const tile = createCanvasImagePendingPixelsAsset()
    const { width, height } = getCanvasImageAssetSize(tile)

    // The renderer makes one texture of it per frame that waits: a few KiB each, not 1 MiB.
    expect(width * height * 4).toBeLessThanOrEqual(8 * 1024)

    // A waiting frame at overview size asks for no source decode of its own ...
    const frame = {
      id: 'pending',
      src: 'local-media:///C:/board/pending.png',
      width: 400,
      height: 300,
      scaleX: 1,
      scaleY: 1,
      sourceWidth: 4096,
      sourceHeight: 3072
    }
    const overview = resolveCanvasImageLodDecision({ item: frame, image: tile, stageScale: 1 })
    expect(overview.usesPlaceholderPreview).toBe(true)
    expect(overview.shouldUseSourceTexture).toBe(false)
    // ... only one that fills the screen does, like a frame that already has its 512 px preview.
    const closeUp = resolveCanvasImageLodDecision({ item: frame, image: tile, stageScale: 3 })
    expect(closeUp.shouldUseSourceTexture).toBe(true)
  })
})
