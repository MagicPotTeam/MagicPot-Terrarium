import React, { useEffect } from 'react'
import { render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  PROJECT_CANVAS_IMAGE_BATCH_LOAD_CONCURRENCY,
  PROJECT_CANVAS_IMAGE_LAZY_IMPORT_EAGER_COUNT,
  PROJECT_CANVAS_IMAGE_LAZY_IMPORT_THRESHOLD,
  PROJECT_CANVAS_IMAGE_STREAM_IMPORT_THRESHOLD,
  PROJECT_CANVAS_IMAGE_THUMBNAIL_RESOLVE_TIMEOUT_MS,
  mapCanvasImageBatchWithConcurrency,
  useCanvasAssetIntake,
  type CanvasImageBatchImportProgress
} from './useCanvasAssetIntake'
import {
  buildCanvasImageSourceIdentity,
  canvasThumbnailManifestFromSet,
  createCanvasThumbnailSet
} from './canvasThumbnailCache'
import type { CanvasImageSourceInput } from './canvasAssetIntakeHelpers'
import type { CanvasGroup, CanvasImageItem, CanvasItem } from './types'

const importCanvasFileMock = vi.fn()

vi.mock('./canvasStorage', () => ({
  importCanvasFile: (...args: unknown[]) => importCanvasFileMock(...args),
  rememberCanvasSaveTargetPath: vi.fn()
}))

function AssetIntakeHarness({
  file,
  resolveCurrentItemCount = () => 0
}: {
  file: File
  resolveCurrentItemCount?: () => number
}) {
  const nextZIndexRef = React.useRef(1)
  const setItemsWithHistory = vi.fn()
  const setGroups = vi.fn()
  const setGroupBranches = vi.fn()
  const setSelectedIds = vi.fn()
  const setTool = vi.fn()

  const { handleImportCanvasSceneFile } = useCanvasAssetIntake({
    canvasId: 'canvas-1',
    nextZIndexRef,
    setItemsWithHistory,
    setGroups,
    setGroupBranches,
    setSelectedIds,
    setTool,
    notifyError: vi.fn(),
    notifyWarning: vi.fn(),
    notifySuccess: vi.fn(),
    resolveCurrentItemCount
  })

  useEffect(() => {
    void handleImportCanvasSceneFile(file)
  }, [file, handleImportCanvasSceneFile])

  return null
}

function LargeImageBatchHarness({
  onComplete,
  onProgress,
  onSelectionChange,
  sources,
  getBatchGridLayout = (sizes) =>
    sizes.map((size, index) => ({
      x: index * 10,
      y: Math.floor(index / 24) * 10,
      width: size.width,
      height: size.height
    }))
}: {
  onComplete: (items: CanvasItem[], result: unknown) => void
  onProgress?: (progress: CanvasImageBatchImportProgress | null) => void
  onSelectionChange?: (selectedIds: Set<string>) => void
  sources: CanvasImageSourceInput[]
  getBatchGridLayout?: (
    sizes: Array<{ width: number; height: number }>,
    options?: { gap?: number; minColumns?: number; maxColumns?: number; allowUpscale?: boolean }
  ) => Array<{ x: number; y: number; width: number; height: number }>
}) {
  const nextZIndexRef = React.useRef(1)
  const itemsRef = React.useRef<CanvasItem[]>([])

  const applyItemsUpdate = React.useCallback((update: React.SetStateAction<CanvasItem[]>) => {
    itemsRef.current = typeof update === 'function' ? update(itemsRef.current) : update
  }, [])
  const setSelectedIds = React.useCallback(
    (update: React.SetStateAction<Set<string>>) => {
      const selectedIds = typeof update === 'function' ? update(new Set<string>()) : update
      onSelectionChange?.(new Set(selectedIds))
    },
    [onSelectionChange]
  )

  const { addImagesToCanvas } = useCanvasAssetIntake({
    canvasId: 'canvas-1',
    fitImageToCanvasSize: (width, height) => ({ width, height }),
    getBatchGridLayout,
    getCenterPosition: () => ({ x: 0, y: 0 }),
    nextZIndexRef,
    setItemsWithHistory: applyItemsUpdate,
    setItemsWithoutHistory: applyItemsUpdate,
    setGroups: vi.fn(),
    setGroupBranches: vi.fn(),
    setSelectedIds,
    setTool: vi.fn(),
    notifyError: vi.fn(),
    notifyWarning: vi.fn(),
    notifySuccess: vi.fn(),
    onImageBatchImportProgress: onProgress
  })

  useEffect(() => {
    let cancelled = false
    void addImagesToCanvas(sources).then((result) => {
      if (!cancelled) {
        onComplete(itemsRef.current, result)
      }
    })
    return () => {
      cancelled = true
    }
  }, [addImagesToCanvas, onComplete, sources])

  return null
}

function SingleImageHarness({
  onComplete,
  options,
  src = 'blob:qapp-image'
}: {
  onComplete: (items: CanvasItem[], result: CanvasImageItem | null | undefined) => void
  options?: Parameters<ReturnType<typeof useCanvasAssetIntake>['addImageToCanvas']>[1]
  src?: string
}) {
  const nextZIndexRef = React.useRef(1)
  const itemsRef = React.useRef<CanvasItem[]>([])

  const applyItemsUpdate = React.useCallback((update: React.SetStateAction<CanvasItem[]>) => {
    itemsRef.current = typeof update === 'function' ? update(itemsRef.current) : update
  }, [])

  const { addImageToCanvas } = useCanvasAssetIntake({
    canvasId: 'canvas-1',
    fitImageToCanvasSize: (width, height) => ({ width, height }),
    getCenterPosition: (width, height) => ({ x: -width / 2, y: -height / 2 }),
    nextZIndexRef,
    setItemsWithHistory: applyItemsUpdate,
    setItemsWithoutHistory: applyItemsUpdate,
    setGroups: vi.fn(),
    setGroupBranches: vi.fn(),
    setSelectedIds: vi.fn(),
    setTool: vi.fn(),
    notifyError: vi.fn(),
    notifyWarning: vi.fn(),
    notifySuccess: vi.fn()
  })

  useEffect(() => {
    let cancelled = false
    void addImageToCanvas(src, options).then((result) => {
      if (!cancelled) {
        onComplete(itemsRef.current, result)
      }
    })
    return () => {
      cancelled = true
    }
  }, [addImageToCanvas, onComplete, options, src])

  return null
}

afterEach(() => {
  vi.clearAllMocks()
})

beforeEach(() => {
  importCanvasFileMock.mockResolvedValue({
    items: [
      {
        id: 'imported-text',
        type: 'text',
        text: 'Imported',
        x: 10,
        y: 10,
        width: 120,
        height: 40,
        rotation: 0,
        scaleX: 1,
        scaleY: 1,
        zIndex: 1,
        locked: false,
        fontSize: 16,
        fontFamily: 'Arial',
        fill: '#fff'
      } satisfies CanvasItem
    ],
    groups: [] as CanvasGroup[],
    groupBranches: [],
    qAppKey: undefined,
    figmaBinding: null
  })
})

describe('useCanvasAssetIntake', () => {
  it('limits batch image preprocessing concurrency and preserves source order', async () => {
    let activeWorkers = 0
    let maxActiveWorkers = 0
    const inputs = Array.from(
      { length: PROJECT_CANVAS_IMAGE_BATCH_LOAD_CONCURRENCY * 3 },
      (_, index) => index
    )

    const results = await mapCanvasImageBatchWithConcurrency(
      inputs,
      PROJECT_CANVAS_IMAGE_BATCH_LOAD_CONCURRENCY,
      async (value) => {
        activeWorkers += 1
        maxActiveWorkers = Math.max(maxActiveWorkers, activeWorkers)
        await new Promise((resolve) => setTimeout(resolve, 1))
        activeWorkers -= 1
        return value === 2 ? null : value
      }
    )

    expect(maxActiveWorkers).toBeLessThanOrEqual(PROJECT_CANVAS_IMAGE_BATCH_LOAD_CONCURRENCY)
    expect(results).toEqual(inputs.filter((value) => value !== 2))
  })

  it('creates source-only lazy items for large image batches after the first-screen eager budget', async () => {
    const originalImageCtor = window.Image
    const loadedSources: string[] = []
    window.Image = function MockImage() {
      const image = document.createElement('img')
      Object.defineProperty(image, 'naturalWidth', { configurable: true, value: 320 })
      Object.defineProperty(image, 'naturalHeight', { configurable: true, value: 180 })
      Object.defineProperty(image, 'width', { configurable: true, value: 320 })
      Object.defineProperty(image, 'height', { configurable: true, value: 180 })
      Object.defineProperty(image, 'src', {
        configurable: true,
        get: () => '',
        set: (value: string) => {
          if (value.startsWith('local-media:///C:/real-board/')) {
            loadedSources.push(value)
          }
          window.setTimeout(() => image.onload?.(new Event('load')), 0)
        }
      })
      return image
    } as unknown as typeof Image

    try {
      const sources = Array.from(
        { length: PROJECT_CANVAS_IMAGE_LAZY_IMPORT_THRESHOLD + 8 },
        (_, index) => ({
          src: `local-media:///C:/real-board/image-${index}.png`,
          fileName: `image-${index}.png`,
          sizeBytes: 1024 + index
        })
      )
      const onComplete = vi.fn()

      render(<LargeImageBatchHarness sources={sources} onComplete={onComplete} />)

      await waitFor(
        () => {
          expect(onComplete).toHaveBeenCalledTimes(1)
        },
        { timeout: 5000 }
      )

      const [items, result] = onComplete.mock.calls[0] as [CanvasItem[], CanvasImageItem[]]
      const imageItems = items.filter((item): item is CanvasImageItem => item.type === 'image')
      expect(result).toHaveLength(sources.length)
      expect(imageItems).toHaveLength(sources.length)
      expect(loadedSources).toHaveLength(PROJECT_CANVAS_IMAGE_LAZY_IMPORT_EAGER_COUNT)
      expect(imageItems.filter((item) => item.image).length).toBe(
        PROJECT_CANVAS_IMAGE_LAZY_IMPORT_EAGER_COUNT
      )
      expect(imageItems[PROJECT_CANVAS_IMAGE_LAZY_IMPORT_EAGER_COUNT].image).toBeUndefined()
      expect(imageItems[PROJECT_CANVAS_IMAGE_LAZY_IMPORT_EAGER_COUNT].sourceWidth).toBe(1536)
      expect(imageItems[PROJECT_CANVAS_IMAGE_LAZY_IMPORT_EAGER_COUNT].sourceHeight).toBe(1536)
    } finally {
      window.Image = originalImageCtor
    }
  })

  it('builds real previews for lazy-tail local files when the source File is still available', async () => {
    const originalImageCtor = window.Image
    const originalCreateImageBitmap = globalThis.createImageBitmap
    const loadedSources: string[] = []
    const tailPreview = {
      width: 192,
      height: 108,
      close: vi.fn()
    } as unknown as ImageBitmap
    const createImageBitmapMock = vi.fn(
      async () => tailPreview
    ) as unknown as typeof createImageBitmap

    Object.defineProperty(globalThis, 'createImageBitmap', {
      configurable: true,
      value: createImageBitmapMock
    })
    window.Image = function MockImage() {
      const image = document.createElement('img')
      Object.defineProperty(image, 'naturalWidth', { configurable: true, value: 320 })
      Object.defineProperty(image, 'naturalHeight', { configurable: true, value: 180 })
      Object.defineProperty(image, 'width', { configurable: true, value: 320 })
      Object.defineProperty(image, 'height', { configurable: true, value: 180 })
      Object.defineProperty(image, 'src', {
        configurable: true,
        get: () => '',
        set: (value: string) => {
          loadedSources.push(value)
          window.setTimeout(() => image.onload?.(new Event('load')), 0)
        }
      })
      return image
    } as unknown as typeof Image

    try {
      const sources: CanvasImageSourceInput[] = Array.from(
        { length: PROJECT_CANVAS_IMAGE_LAZY_IMPORT_THRESHOLD + 1 },
        (_, index) => {
          const lazyTail = index >= PROJECT_CANVAS_IMAGE_LAZY_IMPORT_EAGER_COUNT
          return {
            src: `local-media:///C:/real-board/file-tail-${index}.png`,
            fileName: `file-tail-${index}.png`,
            sizeBytes: 1024 + index,
            sourceWidthHint: 320,
            sourceHeightHint: 180,
            ...(lazyTail
              ? { sourceFile: new File([new Uint8Array([1, 2, 3, 4])], `file-tail-${index}.png`) }
              : {})
          }
        }
      )
      const onComplete = vi.fn()

      render(<LargeImageBatchHarness sources={sources} onComplete={onComplete} />)

      await waitFor(
        () => {
          expect(onComplete).toHaveBeenCalledTimes(1)
        },
        { timeout: 5000 }
      )

      const [items] = onComplete.mock.calls[0] as [CanvasItem[], CanvasImageItem[]]
      const imageItems = items.filter((item): item is CanvasImageItem => item.type === 'image')
      expect(loadedSources).toHaveLength(PROJECT_CANVAS_IMAGE_LAZY_IMPORT_EAGER_COUNT)
      expect(createImageBitmapMock).toHaveBeenCalled()
      expect(imageItems[PROJECT_CANVAS_IMAGE_LAZY_IMPORT_EAGER_COUNT].image).toBe(tailPreview)
    } finally {
      window.Image = originalImageCtor
      if (originalCreateImageBitmap) {
        Object.defineProperty(globalThis, 'createImageBitmap', {
          configurable: true,
          value: originalCreateImageBitmap
        })
      } else {
        delete (globalThis as unknown as { createImageBitmap?: typeof createImageBitmap })
          .createImageBitmap
      }
    }
  })

  it('does not block lazy-tail imports on cold thumbnail generation', async () => {
    const originalImageCtor = window.Image
    const originalApi = window.api
    const loadedSources: string[] = []
    const hangingManifestRead = vi.fn(() => new Promise<never>(() => undefined))

    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        svcCanvasThumbnail: {
          readThumbnailManifest: hangingManifestRead
        }
      }
    })

    window.Image = function MockImage() {
      const image = document.createElement('img')
      Object.defineProperty(image, 'naturalWidth', { configurable: true, value: 320 })
      Object.defineProperty(image, 'naturalHeight', { configurable: true, value: 180 })
      Object.defineProperty(image, 'width', { configurable: true, value: 320 })
      Object.defineProperty(image, 'height', { configurable: true, value: 180 })
      Object.defineProperty(image, 'src', {
        configurable: true,
        get: () => '',
        set: (value: string) => {
          loadedSources.push(value)
          window.setTimeout(() => image.onload?.(new Event('load')), 0)
        }
      })
      return image
    } as unknown as typeof Image

    try {
      const sources: CanvasImageSourceInput[] = Array.from(
        { length: PROJECT_CANVAS_IMAGE_LAZY_IMPORT_THRESHOLD + 8 },
        (_, index) => {
          const lazyTail = index >= PROJECT_CANVAS_IMAGE_LAZY_IMPORT_EAGER_COUNT
          const sizeBytes = lazyTail ? 9 * 1024 * 1024 + index : 1024 + index
          const sourceIdentity = lazyTail
            ? buildCanvasImageSourceIdentity({
                canonicalPath: `C:/real-board/lazy-tail-${index}.png`,
                sizeBytes,
                lastModifiedMs: 1712345678000 + index
              })
            : null

          return {
            src: `local-media:///C:/real-board/lazy-tail-${index}.png`,
            fileName: `lazy-tail-${index}.png`,
            sizeBytes,
            sourceWidthHint: lazyTail ? 2048 : undefined,
            sourceHeightHint: lazyTail ? 1024 : undefined,
            ...(sourceIdentity ? { sourceIdentity } : {})
          }
        }
      )
      const onComplete = vi.fn()

      render(<LargeImageBatchHarness sources={sources} onComplete={onComplete} />)

      await waitFor(
        () => {
          expect(onComplete).toHaveBeenCalledTimes(1)
        },
        { timeout: 5000 }
      )

      const [items, result] = onComplete.mock.calls[0] as [CanvasItem[], CanvasImageItem[]]
      const imageItems = items.filter((item): item is CanvasImageItem => item.type === 'image')
      expect(result).toHaveLength(sources.length)
      expect(imageItems).toHaveLength(sources.length)
      expect(loadedSources).toHaveLength(PROJECT_CANVAS_IMAGE_LAZY_IMPORT_EAGER_COUNT)
      expect(hangingManifestRead).not.toHaveBeenCalled()
      expect(imageItems[PROJECT_CANVAS_IMAGE_LAZY_IMPORT_EAGER_COUNT].image).toBeInstanceOf(
        HTMLCanvasElement
      )
    } finally {
      window.Image = originalImageCtor
      Object.defineProperty(window, 'api', {
        configurable: true,
        value: originalApi
      })
    }
  })

  it('does not upscale streamed batch images to fill a low-zoom viewport', async () => {
    const sources: CanvasImageSourceInput[] = Array.from(
      { length: PROJECT_CANVAS_IMAGE_STREAM_IMPORT_THRESHOLD },
      (_, index) => ({
        src: `https://example.invalid/low-zoom-batch-${index}.png`,
        fileName: `low-zoom-batch-${index}.png`,
        sizeBytes: 9 * 1024 * 1024,
        sourceWidthHint: 736,
        sourceHeightHint: 564
      })
    )
    const getBatchGridLayout = vi.fn(
      (sizes: Array<{ width: number; height: number }>, options?: { allowUpscale?: boolean }) =>
        sizes.map((size, index) => ({
          x: index * 10,
          y: 0,
          width: options?.allowUpscale ? 108_105 : size.width,
          height: options?.allowUpscale ? 82_842 : size.height
        }))
    )
    const onComplete = vi.fn()

    render(
      <LargeImageBatchHarness
        sources={sources}
        onComplete={onComplete}
        getBatchGridLayout={getBatchGridLayout}
      />
    )

    await waitFor(
      () => {
        expect(onComplete).toHaveBeenCalledTimes(1)
      },
      { timeout: 5000 }
    )

    const [items] = onComplete.mock.calls[0] as [CanvasItem[], CanvasImageItem[]]
    const imageItems = items.filter((item): item is CanvasImageItem => item.type === 'image')

    expect(getBatchGridLayout).toHaveBeenCalled()
    expect(getBatchGridLayout.mock.calls.every((call) => call[1]?.allowUpscale === false)).toBe(
      true
    )
    expect(imageItems[0].width).toBe(736)
    expect(imageItems[0].height).toBe(564)
  })

  it('uses warm thumbnail cache as the display image for oversized local imports', async () => {
    const originalImageCtor = window.Image
    const originalApi = window.api
    const loadedSources: string[] = []
    const sourceIdentity = buildCanvasImageSourceIdentity({
      canonicalPath: 'C:/real-board/warm-cache.png',
      sizeBytes: 90 * 1024 * 1024,
      lastModifiedMs: 1712345678000
    })
    expect(sourceIdentity).not.toBeNull()
    const thumbnailSet = createCanvasThumbnailSet({
      identity: sourceIdentity!,
      levels: [
        {
          maxSide: 128,
          src: 'local-media:///cache/warm-cache/128.webp',
          filename: '128.webp',
          mimeType: 'image/webp',
          width: 128,
          height: 64,
          sizeBytes: 128
        },
        {
          maxSide: 256,
          src: 'local-media:///cache/warm-cache/256.webp',
          filename: '256.webp',
          mimeType: 'image/webp',
          width: 256,
          height: 128,
          sizeBytes: 256
        },
        {
          maxSide: 512,
          src: 'local-media:///cache/warm-cache/512.webp',
          filename: '512.webp',
          mimeType: 'image/webp',
          width: 512,
          height: 256,
          sizeBytes: 512
        },
        {
          maxSide: 1024,
          src: 'local-media:///cache/warm-cache/1024.webp',
          filename: '1024.webp',
          mimeType: 'image/webp',
          width: 1024,
          height: 512,
          sizeBytes: 1024
        },
        {
          maxSide: 2048,
          src: 'local-media:///cache/warm-cache/2048.webp',
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
      value: {
        svcCanvasThumbnail: {
          readThumbnailManifest: vi.fn(async () => ({
            manifest: canvasThumbnailManifestFromSet(thumbnailSet)
          }))
        }
      }
    })

    window.Image = function MockImage() {
      const image = document.createElement('img')
      Object.defineProperty(image, 'naturalWidth', { configurable: true, value: 2048 })
      Object.defineProperty(image, 'naturalHeight', { configurable: true, value: 1024 })
      Object.defineProperty(image, 'width', { configurable: true, value: 2048 })
      Object.defineProperty(image, 'height', { configurable: true, value: 1024 })
      Object.defineProperty(image, 'src', {
        configurable: true,
        get: () => '',
        set: (value: string) => {
          loadedSources.push(value)
          window.setTimeout(() => image.onload?.(new Event('load')), 0)
        }
      })
      return image
    } as unknown as typeof Image

    try {
      const source: CanvasImageSourceInput = {
        src: 'local-media:///C:/real-board/warm-cache.png',
        fileName: 'warm-cache.png',
        sizeBytes: 90 * 1024 * 1024,
        sourceWidthHint: 19_717,
        sourceHeightHint: 12_079,
        sourceIdentity: sourceIdentity!
      }
      const onComplete = vi.fn()

      render(<LargeImageBatchHarness sources={[source]} onComplete={onComplete} />)

      await waitFor(
        () => {
          expect(onComplete).toHaveBeenCalledTimes(1)
        },
        { timeout: 5000 }
      )

      const [items, result] = onComplete.mock.calls[0] as [CanvasItem[], CanvasImageItem[]]
      const imageItem = items.find((item): item is CanvasImageItem => item.type === 'image')
      expect(result).toHaveLength(1)
      expect(imageItem?.thumbnailSet).toEqual(thumbnailSet)
      expect(imageItem?.image).toBeInstanceOf(HTMLImageElement)
      expect(loadedSources).toEqual(['local-media:///cache/warm-cache/2048.webp'])
    } finally {
      window.Image = originalImageCtor
      Object.defineProperty(window, 'api', {
        configurable: true,
        value: originalApi
      })
    }
  })

  it('creates resized preview thumbnails for oversized image sources without eager image decoding', async () => {
    const originalImageCtor = window.Image
    const originalCreateImageBitmap = globalThis.createImageBitmap
    const previewBitmap = {
      width: 2048,
      height: 1255,
      close: vi.fn()
    } as unknown as ImageBitmap
    const createImageBitmapMock = vi.fn(
      async () => previewBitmap
    ) as unknown as typeof createImageBitmap
    const loadedSources: string[] = []
    Object.defineProperty(globalThis, 'createImageBitmap', {
      configurable: true,
      value: createImageBitmapMock
    })
    window.Image = function MockImage() {
      const image = document.createElement('img')
      Object.defineProperty(image, 'src', {
        configurable: true,
        get: () => '',
        set: (value: string) => {
          if (value.startsWith('local-media:///C:/real-board/')) {
            loadedSources.push(value)
          }
          window.setTimeout(() => image.onload?.(new Event('load')), 0)
        }
      })
      return image
    } as unknown as typeof Image

    try {
      const hugeSource = {
        src: 'local-media:///C:/real-board/huge.png',
        fileName: 'huge.png',
        sizeBytes: 90 * 1024 * 1024,
        sourceWidthHint: 19_717,
        sourceHeightHint: 12_079,
        sourceFile: new Blob(['png'], { type: 'image/png' })
      }
      const sources: CanvasImageSourceInput[] = [hugeSource]
      const onComplete = vi.fn()

      render(<LargeImageBatchHarness sources={sources} onComplete={onComplete} />)

      await waitFor(
        () => {
          expect(onComplete).toHaveBeenCalledTimes(1)
        },
        { timeout: 5000 }
      )

      const [items, result] = onComplete.mock.calls[0] as [CanvasItem[], CanvasImageItem[]]
      const imageItems = items.filter((item): item is CanvasImageItem => item.type === 'image')
      expect(result).toHaveLength(1)
      expect(imageItems).toHaveLength(1)
      expect(loadedSources).toHaveLength(0)
      expect(createImageBitmapMock).toHaveBeenCalledWith(hugeSource.sourceFile, {
        resizeWidth: 2048,
        resizeHeight: 1255,
        resizeQuality: 'high'
      })
      expect(imageItems[0].image).toBe(previewBitmap)
      expect(imageItems[0].sourceWidth).toBe(19_717)
      expect(imageItems[0].sourceHeight).toBe(12_079)
    } finally {
      window.Image = originalImageCtor
      if (originalCreateImageBitmap) {
        Object.defineProperty(globalThis, 'createImageBitmap', {
          configurable: true,
          value: originalCreateImageBitmap
        })
      } else {
        delete (globalThis as unknown as { createImageBitmap?: typeof createImageBitmap })
          .createImageBitmap
      }
    }
  })

  it('fetches local-media sources for oversized deferred thumbnails when no File blob is attached', async () => {
    const originalImageCtor = window.Image
    const originalCreateImageBitmap = globalThis.createImageBitmap
    const originalFetch = globalThis.fetch
    const previewBlob = new Blob(['png-preview'], { type: 'image/png' })
    const previewBitmap = {
      width: 2048,
      height: 1255,
      close: vi.fn()
    } as unknown as ImageBitmap
    const createImageBitmapMock = vi.fn(
      async () => previewBitmap
    ) as unknown as typeof createImageBitmap
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      blob: async () => previewBlob
    }))
    const loadedSources: string[] = []
    Object.defineProperty(globalThis, 'createImageBitmap', {
      configurable: true,
      value: createImageBitmapMock
    })
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: fetchMock
    })
    window.Image = function MockImage() {
      const image = document.createElement('img')
      Object.defineProperty(image, 'src', {
        configurable: true,
        get: () => '',
        set: (value: string) => {
          if (value.startsWith('local-media:///C:/real-board/')) {
            loadedSources.push(value)
          }
          window.setTimeout(() => image.onload?.(new Event('load')), 0)
        }
      })
      return image
    } as unknown as typeof Image

    try {
      const hugeSource = {
        src: 'local-media:///C:/real-board/huge-from-url.png',
        fileName: 'huge-from-url.png',
        sizeBytes: 90 * 1024 * 1024,
        sourceWidthHint: 19_717,
        sourceHeightHint: 12_079
      }
      const sources: CanvasImageSourceInput[] = [hugeSource]
      const onComplete = vi.fn()

      render(<LargeImageBatchHarness sources={sources} onComplete={onComplete} />)

      await waitFor(
        () => {
          expect(onComplete).toHaveBeenCalledTimes(1)
        },
        { timeout: 5000 }
      )

      const [items, result] = onComplete.mock.calls[0] as [CanvasItem[], CanvasImageItem[]]
      const imageItems = items.filter((item): item is CanvasImageItem => item.type === 'image')
      expect(result).toHaveLength(1)
      expect(imageItems).toHaveLength(1)
      expect(loadedSources).toHaveLength(0)
      expect(fetchMock).toHaveBeenCalledWith(hugeSource.src)
      expect(createImageBitmapMock).toHaveBeenCalledWith(previewBlob, {
        resizeWidth: 2048,
        resizeHeight: 1255,
        resizeQuality: 'high'
      })
      expect(imageItems[0].image).toBe(previewBitmap)
    } finally {
      window.Image = originalImageCtor
      if (originalCreateImageBitmap) {
        Object.defineProperty(globalThis, 'createImageBitmap', {
          configurable: true,
          value: originalCreateImageBitmap
        })
      } else {
        delete (globalThis as unknown as { createImageBitmap?: typeof createImageBitmap })
          .createImageBitmap
      }
      if (originalFetch) {
        Object.defineProperty(globalThis, 'fetch', {
          configurable: true,
          value: originalFetch
        })
      } else {
        delete (globalThis as unknown as { fetch?: typeof fetch }).fetch
      }
    }
  })

  it('reads local-media deferred previews through svcFs when the file bridge is available', async () => {
    const originalApi = window.api
    const originalCreateImageBitmap = globalThis.createImageBitmap
    const originalFetch = globalThis.fetch
    const readImageFromPath = vi.fn(async () => ({
      image: new Uint8Array([1, 2, 3, 4]),
      filename: 'huge-from-bridge.png'
    }))
    const previewBitmap = {
      width: 2048,
      height: 1255,
      close: vi.fn()
    } as unknown as ImageBitmap
    const createImageBitmapMock = vi.fn(
      async () => previewBitmap
    ) as unknown as typeof createImageBitmap
    const fetchMock = vi.fn()

    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: {
        svcFs: {
          readImageFromPath
        }
      }
    })
    Object.defineProperty(globalThis, 'createImageBitmap', {
      configurable: true,
      value: createImageBitmapMock
    })
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: fetchMock
    })

    try {
      const hugeSource = {
        src: 'local-media:///C:/real-board/huge-from-bridge.png',
        fileName: 'huge-from-bridge.png',
        sizeBytes: 90 * 1024 * 1024,
        sourceWidthHint: 19_717,
        sourceHeightHint: 12_079
      }
      const onComplete = vi.fn()

      render(<LargeImageBatchHarness sources={[hugeSource]} onComplete={onComplete} />)

      await waitFor(
        () => {
          expect(onComplete).toHaveBeenCalledTimes(1)
        },
        { timeout: 5000 }
      )

      const [items] = onComplete.mock.calls[0] as [CanvasItem[], CanvasImageItem[]]
      const imageItems = items.filter((item): item is CanvasImageItem => item.type === 'image')
      expect(readImageFromPath).toHaveBeenCalledWith({
        fullPath: 'C:/real-board/huge-from-bridge.png'
      })
      expect(fetchMock).not.toHaveBeenCalled()
      expect(createImageBitmapMock).toHaveBeenCalledWith(expect.any(Blob), {
        resizeWidth: 2048,
        resizeHeight: 1255,
        resizeQuality: 'high'
      })
      expect(imageItems[0].image).toBe(previewBitmap)
    } finally {
      Object.defineProperty(window, 'api', {
        configurable: true,
        writable: true,
        value: originalApi
      })
      if (originalCreateImageBitmap) {
        Object.defineProperty(globalThis, 'createImageBitmap', {
          configurable: true,
          value: originalCreateImageBitmap
        })
      } else {
        delete (globalThis as unknown as { createImageBitmap?: typeof createImageBitmap })
          .createImageBitmap
      }
      if (originalFetch) {
        Object.defineProperty(globalThis, 'fetch', {
          configurable: true,
          value: originalFetch
        })
      } else {
        delete (globalThis as unknown as { fetch?: typeof fetch }).fetch
      }
    }
  })

  it('continues deferred batch imports when thumbnail resolution stalls', async () => {
    vi.useFakeTimers()
    const originalApi = window.api
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const hangingManifestRead = vi.fn(() => new Promise<never>(() => undefined))

    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        svcCanvasThumbnail: {
          readThumbnailManifest: hangingManifestRead
        }
      }
    })

    try {
      const sources: CanvasImageSourceInput[] = Array.from(
        { length: PROJECT_CANVAS_IMAGE_BATCH_LOAD_CONCURRENCY },
        (_, index) => {
          const sizeBytes = 9 * 1024 * 1024 + index
          const sourceIdentity = buildCanvasImageSourceIdentity({
            canonicalPath: `C:/real-board/stalled-thumbnail-${index}.png`,
            sizeBytes,
            lastModifiedMs: 1712345678000 + index
          })
          expect(sourceIdentity).not.toBeNull()

          return {
            src: `https://example.invalid/stalled-thumbnail-${index}.png`,
            fileName: `stalled-thumbnail-${index}.png`,
            sizeBytes,
            sourceWidthHint: 2048,
            sourceHeightHint: 1024,
            sourceIdentity: sourceIdentity!
          }
        }
      )
      const onComplete = vi.fn()

      render(<LargeImageBatchHarness sources={sources} onComplete={onComplete} />)

      await vi.advanceTimersByTimeAsync(PROJECT_CANVAS_IMAGE_THUMBNAIL_RESOLVE_TIMEOUT_MS + 1)
      await vi.runOnlyPendingTimersAsync()

      expect(onComplete).toHaveBeenCalledTimes(1)
      const [items, result] = onComplete.mock.calls[0] as [CanvasItem[], CanvasImageItem[]]
      const imageItems = items.filter((item): item is CanvasImageItem => item.type === 'image')
      expect(result).toHaveLength(sources.length)
      expect(imageItems).toHaveLength(sources.length)
      expect(hangingManifestRead).toHaveBeenCalled()
      expect(warnSpy).toHaveBeenCalledWith(
        '[Canvas] Image intake thumbnail timed out or failed, continuing without thumbnail:',
        expect.any(String),
        expect.any(Error)
      )
    } finally {
      vi.useRealTimers()
      warnSpy.mockRestore()
      Object.defineProperty(window, 'api', {
        configurable: true,
        value: originalApi
      })
    }
  })

  it('compacts streamed image batches into a balanced sheet instead of preserving chunk stacks', async () => {
    const sources: CanvasImageSourceInput[] = Array.from({ length: 48 }, (_, index) => ({
      src: `https://example.invalid/real-board/oversized-${index}.png`,
      fileName: `oversized-${index}.png`,
      sizeBytes: 9 * 1024 * 1024,
      sourceWidthHint: 120,
      sourceHeightHint: 90
    }))
    const onComplete = vi.fn()

    render(<LargeImageBatchHarness sources={sources} onComplete={onComplete} />)

    await waitFor(
      () => {
        expect(onComplete).toHaveBeenCalledTimes(1)
      },
      { timeout: 5000 }
    )

    const [items, result] = onComplete.mock.calls[0] as [CanvasItem[], CanvasImageItem[]]
    const imageItems = items.filter((item): item is CanvasImageItem => item.type === 'image')
    const uniqueColumns = new Set(imageItems.map((item) => item.x)).size
    const uniqueRows = new Set(imageItems.map((item) => item.y)).size
    const minX = Math.min(...imageItems.map((item) => item.x))
    const maxRight = Math.max(...imageItems.map((item) => item.x + item.width))
    const minY = Math.min(...imageItems.map((item) => item.y))
    const maxBottom = Math.max(...imageItems.map((item) => item.y + item.height))

    expect(result).toHaveLength(sources.length)
    expect(imageItems).toHaveLength(sources.length)
    expect(uniqueColumns).toBeGreaterThan(2)
    expect(uniqueColumns).toBeLessThan(24)
    expect(uniqueRows).toBeGreaterThan(2)
    expect((maxBottom - minY) / (maxRight - minX)).toBeLessThan(1.2)
  })

  it('reports progress while streaming large image batches into the canvas', async () => {
    const sources: CanvasImageSourceInput[] = Array.from({ length: 48 }, (_, index) => ({
      src: `https://example.invalid/real-board/progress-${index}.png`,
      fileName: `progress-${index}.png`,
      sizeBytes: 9 * 1024 * 1024,
      sourceWidthHint: 160,
      sourceHeightHint: 90
    }))
    const onComplete = vi.fn()
    const onProgress = vi.fn()

    render(
      <LargeImageBatchHarness sources={sources} onComplete={onComplete} onProgress={onProgress} />
    )

    await waitFor(
      () => {
        expect(onComplete).toHaveBeenCalledTimes(1)
      },
      { timeout: 5000 }
    )

    const progressEvents = onProgress.mock.calls.map(
      ([progress]) => progress as CanvasImageBatchImportProgress
    )
    expect(progressEvents[0]).toMatchObject({
      phase: 'loading',
      total: sources.length,
      processed: 0,
      imported: 0,
      failed: 0
    })
    expect(progressEvents.some((event) => event.phase === 'committing')).toBe(true)
    expect(progressEvents.at(-1)).toMatchObject({
      phase: 'complete',
      total: sources.length,
      processed: sources.length,
      imported: sources.length,
      failed: 0
    })
  })

  it('clears selection after importing multiple images as a batch', async () => {
    const sources: CanvasImageSourceInput[] = Array.from({ length: 48 }, (_, index) => ({
      src: `https://example.invalid/real-board/unselected-${index}.png`,
      fileName: `unselected-${index}.png`,
      sizeBytes: 9 * 1024 * 1024,
      sourceWidthHint: 160,
      sourceHeightHint: 90
    }))
    const onComplete = vi.fn()
    const selectionChanges: Set<string>[] = []

    render(
      <LargeImageBatchHarness
        sources={sources}
        onComplete={onComplete}
        onSelectionChange={(selectedIds) => selectionChanges.push(selectedIds)}
      />
    )

    await waitFor(
      () => {
        expect(onComplete).toHaveBeenCalledTimes(1)
      },
      { timeout: 5000 }
    )

    expect(selectionChanges.at(-1)).toEqual(new Set())
  })

  it('uses decoded image dimensions when external source hints do not match the decoded aspect ratio', async () => {
    const originalImageCtor = window.Image
    window.Image = function MockImage() {
      const image = document.createElement('img')
      Object.defineProperty(image, 'naturalWidth', { configurable: true, value: 3136 })
      Object.defineProperty(image, 'naturalHeight', { configurable: true, value: 1568 })
      Object.defineProperty(image, 'width', { configurable: true, value: 3136 })
      Object.defineProperty(image, 'height', { configurable: true, value: 1568 })
      Object.defineProperty(image, 'src', {
        configurable: true,
        get: () => '',
        set: () => {
          window.setTimeout(() => image.onload?.(new Event('load')), 0)
        }
      })
      return image
    } as unknown as typeof Image

    try {
      const onComplete = vi.fn()

      render(
        <SingleImageHarness
          onComplete={onComplete}
          options={{
            fileName: 'qapp-result.png',
            sourceWidthHint: 3136,
            sourceHeightHint: 2624
          }}
        />
      )

      await waitFor(() => {
        expect(onComplete).toHaveBeenCalledTimes(1)
      })

      const [items, result] = onComplete.mock.calls[0] as [
        CanvasItem[],
        CanvasImageItem | null | undefined
      ]
      const imageItem = items.find((item): item is CanvasImageItem => item.type === 'image')

      expect(result).toBeTruthy()
      expect(imageItem).toBeTruthy()
      expect(imageItem?.sourceWidth).toBe(3136)
      expect(imageItem?.sourceHeight).toBe(1568)
      expect(imageItem?.width).toBe(3136)
      expect(imageItem?.height).toBe(1568)
    } finally {
      window.Image = originalImageCtor
    }
  })

  it('preserves the original source File blob on the canvas image item', async () => {
    const originalImageCtor = window.Image
    window.Image = function MockImage() {
      const image = document.createElement('img')
      Object.defineProperty(image, 'naturalWidth', { configurable: true, value: 320 })
      Object.defineProperty(image, 'naturalHeight', { configurable: true, value: 180 })
      Object.defineProperty(image, 'width', { configurable: true, value: 320 })
      Object.defineProperty(image, 'height', { configurable: true, value: 180 })
      Object.defineProperty(image, 'src', {
        configurable: true,
        get: () => '',
        set: () => {
          window.setTimeout(() => image.onload?.(new Event('load')), 0)
        }
      })
      return image
    } as unknown as typeof Image

    try {
      const sourceFile = new Blob(['original-image-bytes'], { type: 'image/png' })
      const onComplete = vi.fn()

      render(
        <SingleImageHarness
          src="blob:qapp-image-with-source-file"
          onComplete={onComplete}
          options={{
            fileName: 'qapp-result.png',
            sourceFile
          }}
        />
      )

      await waitFor(() => {
        expect(onComplete).toHaveBeenCalledTimes(1)
      })

      const [items, result] = onComplete.mock.calls[0] as [
        CanvasItem[],
        CanvasImageItem | null | undefined
      ]
      const imageItem = items.find((item): item is CanvasImageItem => item.type === 'image')

      expect(result?.sourceFile).toBe(sourceFile)
      expect(imageItem?.sourceFile).toBe(sourceFile)
    } finally {
      window.Image = originalImageCtor
    }
  })

  it('binds the imported .mpcanvas path as the current save target when opening into an empty canvas', async () => {
    const file = new File(['{}'], 'opened-file.mpcanvas', {
      type: 'application/json'
    }) as File & { path?: string }
    file.path = 'C:\\projects\\opened-file.mpcanvas'

    const canvasStorage = await import('./canvasStorage')

    render(<AssetIntakeHarness file={file} />)

    await waitFor(() => {
      expect(canvasStorage.rememberCanvasSaveTargetPath).toHaveBeenCalledWith(
        'canvas-1',
        'C:\\projects\\opened-file.mpcanvas'
      )
    })
  })

  it('does not replace the current save target when .mpcanvas content is merged into a non-empty canvas', async () => {
    const file = new File(['{}'], 'merged-file.mpcanvas', {
      type: 'application/json'
    }) as File & { path?: string }
    file.path = 'C:\\projects\\merged-file.mpcanvas'

    const canvasStorage = await import('./canvasStorage')

    render(<AssetIntakeHarness file={file} resolveCurrentItemCount={() => 3} />)

    await waitFor(() => {
      expect(importCanvasFileMock).toHaveBeenCalledWith(file)
    })

    expect(canvasStorage.rememberCanvasSaveTargetPath).not.toHaveBeenCalled()
  })
})
