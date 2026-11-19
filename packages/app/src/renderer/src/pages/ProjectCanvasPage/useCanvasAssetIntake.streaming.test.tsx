import type { SetStateAction } from 'react'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  PROJECT_CANVAS_IMAGE_STREAM_PATCH_FRAME_LIMIT,
  getCanvasImageStreamPixelConcurrency,
  useCanvasAssetIntake,
  type CanvasImageBatchImportProgress
} from './useCanvasAssetIntake'
import {
  isCanvasImagePendingPixelsAsset,
  type CanvasImageSourceInput
} from './canvasAssetIntakeHelpers'
import { isCanvasImagePlaceholderAsset } from './canvasImageAssetUtils'
import { buildCanvasImageSourceIdentity, createCanvasThumbnailSet } from './canvasThumbnailCache'
import { createCanvasHistorySnapshot, restoreCanvasHistorySnapshot } from './canvasHistory'
import type { CanvasImageAsset, CanvasImageItem, CanvasItem } from './types'

type ThumbnailResolverArgs = { src: string; onFirstImage?: (image: CanvasImageAsset) => void }
type ThumbnailResult = { image: CanvasImageAsset; thumbnailSet: unknown } | null

const thumbnailResolver = vi.fn<(args: ThumbnailResolverArgs) => Promise<ThumbnailResult>>()
const loadImageFromSrcMock = vi.fn<(src: string) => Promise<unknown>>()

vi.mock('./canvasAssetIntakeHelpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./canvasAssetIntakeHelpers')>()
  return {
    ...actual,
    resolveCanvasImageThumbnailDisplayAsset: (args: ThumbnailResolverArgs) =>
      thumbnailResolver(args),
    loadImageFromSrc: (src: string) => loadImageFromSrcMock(src)
  }
})

const prewarmMock = vi.fn<(count: number) => number>(() => 0)

vi.mock('./canvasThumbnailWorkerClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./canvasThumbnailWorkerClient')>()
  return {
    ...actual,
    prewarmCanvasThumbnailWorkers: (count: number) => prewarmMock(count)
  }
})

vi.mock('./canvasStorage', () => ({
  importCanvasFile: vi.fn(),
  rememberCanvasSaveTargetPath: vi.fn()
}))

const COLUMNS = 10
const CELL = 200

function createSources(count: number, label = 'stream'): CanvasImageSourceInput[] {
  return Array.from({ length: count }, (_, index) => {
    const sizeBytes = 4096 + index
    const sourceIdentity = buildCanvasImageSourceIdentity({
      canonicalPath: `C:/board/${label}-${index}.png`,
      sizeBytes,
      lastModifiedMs: 1712345678000 + index
    })
    return {
      src: `local-media:///C:/board/${label}-${index}.png`,
      fileName: `${label}-${index}.png`,
      sizeBytes,
      sourceWidthHint: 1024,
      sourceHeightHint: 768,
      sourceIdentity: sourceIdentity!
    }
  })
}

function createThumbnailResult(src: string): NonNullable<ThumbnailResult> {
  const image = document.createElement('img')
  image.alt = src
  const sourceIdentity = buildCanvasImageSourceIdentity({
    canonicalPath: src.replace('local-media:///', ''),
    sizeBytes: 1,
    lastModifiedMs: 1
  })!
  return { image, thumbnailSet: createCanvasThumbnailSet({ identity: sourceIdentity, levels: [] }) }
}

/** Items with the history semantics of the canvas page: snapshots without runtime pixels. */
function createCanvasStore() {
  const store = {
    items: [] as CanvasItem[],
    history: [] as CanvasItem[][],
    future: [] as CanvasItem[][],
    updates: [] as CanvasItem[][],
    historyCommits: 0,
    setItemsWithHistory(update: SetStateAction<CanvasItem[]>) {
      const next = typeof update === 'function' ? update(store.items) : update
      if (next === store.items) return
      store.history.push(createCanvasHistorySnapshot(store.items))
      store.future = []
      store.items = next
      store.historyCommits += 1
      store.updates.push(next)
    },
    setItemsWithoutHistory(update: SetStateAction<CanvasItem[]>) {
      const next = typeof update === 'function' ? update(store.items) : update
      if (next === store.items) return
      store.items = next
      store.updates.push(next)
    },
    undo() {
      const previous = store.history.pop()
      if (!previous) return
      store.future.unshift(createCanvasHistorySnapshot(store.items))
      store.items = restoreCanvasHistorySnapshot(previous, store.items)
    },
    redo() {
      const next = store.future.shift()
      if (!next) return
      store.history.push(createCanvasHistorySnapshot(store.items))
      store.items = restoreCanvasHistorySnapshot(next, store.items)
    },
    images(): CanvasImageItem[] {
      return store.items.filter((item): item is CanvasImageItem => item.type === 'image')
    }
  }
  return store
}

function renderIntake(
  store: ReturnType<typeof createCanvasStore>,
  options: {
    viewport?: () => { x: number; y: number; width: number; height: number }
    onProgress?: (progress: CanvasImageBatchImportProgress | null) => void
  } = {}
) {
  const nextZIndexRef = { current: 1 }
  return renderHook(() =>
    useCanvasAssetIntake({
      canvasId: 'canvas-1',
      fitImageToCanvasSize: () => ({ width: 160, height: 120 }),
      getBatchGridLayout: (sizes) =>
        sizes.map((size, index) => ({
          x: (index % COLUMNS) * CELL,
          y: Math.floor(index / COLUMNS) * CELL,
          width: size.width,
          height: size.height
        })),
      getCenterPosition: () => ({ x: 0, y: 0 }),
      getViewportBounds: () => options.viewport?.() ?? { x: 0, y: 0, width: 1, height: 1 },
      nextZIndexRef,
      setItemsWithHistory: store.setItemsWithHistory,
      setItemsWithoutHistory: store.setItemsWithoutHistory,
      setGroups: vi.fn(),
      setGroupBranches: vi.fn(),
      setSelectedIds: vi.fn(),
      setTool: vi.fn(),
      notifyError: vi.fn(),
      notifyWarning: vi.fn(),
      notifySuccess: vi.fn(),
      onImageBatchImportProgress: options.onProgress
    })
  )
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined
  let reject: (error: unknown) => void = () => undefined
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const rectsOf = (items: CanvasItem[]) =>
  items.map((item) => [item.id, item.x, item.y, item.width, item.height])
const countRealPixels = (items: CanvasItem[]) =>
  items.filter(
    (item) => item.type === 'image' && item.image && !isCanvasImagePlaceholderAsset(item.image)
  ).length

beforeEach(() => {
  thumbnailResolver.mockReset()
  thumbnailResolver.mockImplementation(async ({ src }) => createThumbnailResult(src))
  loadImageFromSrcMock.mockReset()
  loadImageFromSrcMock.mockRejectedValue(new Error('Failed to load image'))
  prewarmMock.mockReset()
  prewarmMock.mockReturnValue(0)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('useCanvasAssetIntake placeholder-first streaming import', () => {
  it('puts every sized frame on the canvas in one history entry before any pixels are resolved', async () => {
    const gate = deferred<void>()
    thumbnailResolver.mockImplementation(async ({ src }) => {
      await gate.promise
      return createThumbnailResult(src)
    })
    const store = createCanvasStore()
    const sources = createSources(60)
    const { result } = renderIntake(store)

    let done = false
    let imported: unknown[] = []
    await act(async () => {
      void result.current.addImagesToCanvas(sources).then((items) => {
        imported = items
        done = true
      })
    })

    await waitFor(() => expect(store.items).toHaveLength(sources.length))
    await waitFor(() =>
      expect(thumbnailResolver).toHaveBeenCalledTimes(getCanvasImageStreamPixelConcurrency())
    )
    expect(done).toBe(false)
    expect(store.historyCommits).toBe(1)
    expect(store.updates).toHaveLength(1)
    const frames = store.images()
    expect(frames.every((item) => isCanvasImagePendingPixelsAsset(item.image))).toBe(true)
    expect(frames.every((item) => item.width === 160 && item.height === 120)).toBe(true)
    expect(frames.every((item) => item.sourceWidth === 1024 && item.sourceHeight === 768)).toBe(
      true
    )
    expect(new Set(frames.map((item) => `${item.x}:${item.y}`)).size).toBe(sources.length)
    // Only the concurrency window is being worked on while all 60 frames are already visible.
    expect(thumbnailResolver).toHaveBeenCalledTimes(getCanvasImageStreamPixelConcurrency())
    const committedRects = rectsOf(store.items)

    await act(async () => {
      gate.resolve()
    })
    await waitFor(() => expect(done).toBe(true), { timeout: 5000 })

    expect(imported).toHaveLength(sources.length)
    expect(store.historyCommits).toBe(1)
    expect(store.history).toHaveLength(1)
    expect(countRealPixels(store.items)).toBe(sources.length)
    expect(store.images().every((item) => item.thumbnailSet)).toBe(true)
    // The layout of the first commit is the final one.
    for (const update of store.updates) {
      expect(rectsOf(update)).toEqual(committedRects)
    }
    // One undo step removes the whole import.
    store.undo()
    expect(store.items).toHaveLength(0)
  })

  it('starts the thumbnail workers before the header pass of a streamed import only', async () => {
    const order: string[] = []
    prewarmMock.mockImplementation(() => {
      order.push('prewarm')
      return 2
    })
    thumbnailResolver.mockImplementation(async ({ src }) => {
      order.push('thumbnail')
      return createThumbnailResult(src)
    })
    const store = createCanvasStore()
    const { result } = renderIntake(store)

    await act(async () => {
      await result.current.addImagesToCanvas(createSources(30))
    })
    expect(prewarmMock).toHaveBeenCalledTimes(1)
    expect(prewarmMock).toHaveBeenCalledWith(30)
    expect(order[0]).toBe('prewarm')
    expect(order.filter((step) => step === 'thumbnail')).toHaveLength(30)

    // A few images do not stream: no workers are started ahead for them.
    prewarmMock.mockClear()
    await act(async () => {
      await result.current.addImagesToCanvas(createSources(3, 'few'))
    })
    expect(prewarmMock).not.toHaveBeenCalled()
  })

  it('hands over a bounded number of images per frame', async () => {
    const store = createCanvasStore()
    const sources = createSources(72)
    const { result } = renderIntake(store)

    await act(async () => {
      await result.current.addImagesToCanvas(sources)
    })

    expect(countRealPixels(store.items)).toBe(sources.length)
    let previous = 0
    for (const update of store.updates) {
      const current = countRealPixels(update)
      expect(current - previous).toBeLessThanOrEqual(PROJECT_CANVAS_IMAGE_STREAM_PATCH_FRAME_LIMIT)
      previous = current
    }
    expect(store.updates.length).toBeGreaterThanOrEqual(
      1 + Math.ceil(sources.length / PROJECT_CANVAS_IMAGE_STREAM_PATCH_FRAME_LIMIT)
    )
  })

  it('resolves the frames inside the viewport first', async () => {
    const order: string[] = []
    thumbnailResolver.mockImplementation(async ({ src }) => {
      order.push(src)
      return createThumbnailResult(src)
    })
    const store = createCanvasStore()
    const sources = createSources(60)
    const indexOf = (src: string) => Number(/-(\d+)\.png$/.exec(src)?.[1])
    // Only the last twenty frames (source indices 40-59) are on screen.
    const viewport = () => {
      const visible = store.images().filter((item) => indexOf(item.src) >= 40)
      if (visible.length === 0) return { x: 0, y: 0, width: 1, height: 1 }
      const left = Math.min(...visible.map((item) => item.x))
      const top = Math.min(...visible.map((item) => item.y))
      return {
        x: left,
        y: top,
        width: Math.max(...visible.map((item) => item.x + item.width)) - left,
        height: Math.max(...visible.map((item) => item.y + item.height)) - top
      }
    }
    const { result } = renderIntake(store, { viewport })

    await act(async () => {
      await result.current.addImagesToCanvas(sources)
    })

    expect(order).toHaveLength(sources.length)
    expect(
      order
        .slice(0, 20)
        .map(indexOf)
        .sort((left, right) => left - right)
    ).toEqual(Array.from({ length: 20 }, (_, index) => 40 + index))
  })

  it('shows a failed tile for an image that cannot be decoded and finishes the rest', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    thumbnailResolver.mockImplementation(async ({ src }) =>
      src.endsWith('stream-7.png') ? null : createThumbnailResult(src)
    )
    const progress: CanvasImageBatchImportProgress[] = []
    const store = createCanvasStore()
    const sources = createSources(30)
    const { result } = renderIntake(store, {
      onProgress: (event) => {
        if (event) progress.push(event)
      }
    })

    await act(async () => {
      await result.current.addImagesToCanvas(sources)
    })

    const frames = store.images()
    const failed = frames.find((item) => item.fileName === 'stream-7.png')
    expect(frames).toHaveLength(sources.length)
    expect(failed?.image).toBeDefined()
    expect(isCanvasImagePlaceholderAsset(failed?.image)).toBe(true)
    expect(isCanvasImagePendingPixelsAsset(failed?.image)).toBe(false)
    expect(countRealPixels(store.items)).toBe(sources.length - 1)
    expect(frames.some((item) => isCanvasImagePendingPixelsAsset(item.image))).toBe(false)
    expect(progress.at(-1)).toMatchObject({
      phase: 'complete',
      total: sources.length,
      processed: sources.length,
      imported: sources.length - 1,
      failed: 1
    })
    expect(consoleError).toHaveBeenCalled()
  })

  it('stops when the import is undone while it runs and never adds the frames back', async () => {
    const gates = new Map<string, ReturnType<typeof deferred<void>>>()
    thumbnailResolver.mockImplementation(async ({ src }) => {
      const gate = deferred<void>()
      gates.set(src, gate)
      await gate.promise
      return createThumbnailResult(src)
    })
    const store = createCanvasStore()
    const sources = createSources(40)
    const { result } = renderIntake(store)

    let done = false
    await act(async () => {
      void result.current.addImagesToCanvas(sources).then(() => {
        done = true
      })
    })
    await waitFor(() => expect(store.items).toHaveLength(sources.length))

    // Two images get their pixels, then the user presses undo.
    const releaseStarted = async (count: number) => {
      await act(async () => {
        ;[...gates.entries()].slice(0, count).forEach(([src, gate]) => {
          gates.delete(src)
          gate.resolve()
        })
      })
    }
    await releaseStarted(2)
    await waitFor(() => expect(countRealPixels(store.items)).toBe(2))
    store.undo()
    expect(store.items).toHaveLength(0)

    for (let round = 0; round < 12 && !done; round += 1) {
      await releaseStarted(gates.size)
      await new Promise((resolve) => setTimeout(resolve, 60))
    }

    await waitFor(() => expect(done).toBe(true), { timeout: 5000 })
    expect(store.items).toHaveLength(0)
    expect(store.history).toHaveLength(0)
    expect(store.future).toHaveLength(1)
    // The remaining sources were not turned into thumbnails for frames that no longer exist.
    expect(thumbnailResolver.mock.calls.length).toBeLessThan(sources.length)
  })

  it('gives pixels back to frames that undo and redo return while the import still runs', async () => {
    const gates = new Map<string, ReturnType<typeof deferred<void>>>()
    thumbnailResolver.mockImplementation(async ({ src }) => {
      const gate = deferred<void>()
      gates.set(src, gate)
      await gate.promise
      return createThumbnailResult(src)
    })
    const store = createCanvasStore()
    const sources = createSources(30)
    const { result } = renderIntake(store)

    let done = false
    await act(async () => {
      void result.current.addImagesToCanvas(sources).then(() => {
        done = true
      })
    })
    await waitFor(() => expect(store.items).toHaveLength(sources.length))
    const releaseStarted = async () => {
      await act(async () => {
        ;[...gates.entries()].forEach(([src, gate]) => {
          gates.delete(src)
          gate.resolve()
        })
      })
    }
    await releaseStarted()
    await waitFor(() => expect(countRealPixels(store.items)).toBeGreaterThanOrEqual(4))

    // Undo and redo at once: the frames come back from history without their runtime pixels.
    store.undo()
    store.redo()
    expect(store.items).toHaveLength(sources.length)
    expect(countRealPixels(store.items)).toBe(0)

    for (let round = 0; round < 40 && !done; round += 1) {
      await releaseStarted()
      await new Promise((resolve) => setTimeout(resolve, 30))
    }
    await waitFor(() => expect(done).toBe(true), { timeout: 5000 })

    expect(store.items).toHaveLength(sources.length)
    expect(countRealPixels(store.items)).toBe(sources.length)
    expect(store.images().some((item) => isCanvasImagePendingPixelsAsset(item.image))).toBe(false)
  })

  it('gives the thumbnail set back to a frame that an undo returns from before its hand-over', async () => {
    const gates = new Map<string, ReturnType<typeof deferred<void>>>()
    thumbnailResolver.mockImplementation(async ({ src }) => {
      const gate = deferred<void>()
      gates.set(src, gate)
      await gate.promise
      return createThumbnailResult(src)
    })
    const store = createCanvasStore()
    const sources = createSources(30)
    const { result } = renderIntake(store)

    let done = false
    await act(async () => {
      void result.current.addImagesToCanvas(sources).then(() => {
        done = true
      })
    })
    await waitFor(() => expect(store.items).toHaveLength(sources.length))

    // The user moves a frame while every frame still waits: a second history entry, whose
    // snapshot holds the frames without thumbnail sets.
    const movedId = store.items[29].id
    store.setItemsWithHistory((items) =>
      items.map((item) => (item.id === movedId ? { ...item, x: item.x + 40 } : item))
    )
    const releaseStarted = async () => {
      await act(async () => {
        ;[...gates.entries()].forEach(([src, gate]) => {
          gates.delete(src)
          gate.resolve()
        })
      })
    }
    await releaseStarted()
    await waitFor(() =>
      expect(store.images().filter((item) => item.thumbnailSet).length).toBeGreaterThanOrEqual(4)
    )

    // Undo of the move: the frames keep their pixels (same ids) but lose the sets they got
    // after that snapshot.
    store.undo()
    expect(store.items).toHaveLength(sources.length)
    expect(store.images().some((item) => item.thumbnailSet)).toBe(false)

    for (let round = 0; round < 40 && !done; round += 1) {
      await releaseStarted()
      await new Promise((resolve) => setTimeout(resolve, 30))
    }
    await waitFor(() => expect(done).toBe(true), { timeout: 5000 })

    expect(countRealPixels(store.items)).toBe(sources.length)
    expect(store.images().every((item) => Boolean(item.thumbnailSet))).toBe(true)
    // The import itself is still one history entry (the undone move left none).
    expect(store.history).toHaveLength(1)
  })

  it('shares the pixel concurrency between two imports started back to back', async () => {
    let active = 0
    let maxActive = 0
    thumbnailResolver.mockImplementation(async ({ src }) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      active -= 1
      return createThumbnailResult(src)
    })
    const store = createCanvasStore()
    const { result } = renderIntake(store)

    await act(async () => {
      await Promise.all([
        result.current.addImagesToCanvas(createSources(30, 'first')),
        result.current.addImagesToCanvas(createSources(30, 'second'))
      ])
    })

    expect(store.items).toHaveLength(60)
    expect(store.historyCommits).toBe(2)
    expect(countRealPixels(store.items)).toBe(60)
    expect(maxActive).toBeLessThanOrEqual(getCanvasImageStreamPixelConcurrency())
  })

  it('shows the display image of a large source before its thumbnail set and never swaps it afterwards', async () => {
    const gates = new Map<string, ReturnType<typeof deferred<void>>>()
    const earlyImages = new Map<string, CanvasImageAsset>()
    const lateEarlyImage: Array<() => void> = []
    thumbnailResolver.mockImplementation(async ({ src, onFirstImage }) => {
      // The display level is handed over while the larger levels are still being encoded ...
      const result = createThumbnailResult(src)
      earlyImages.set(src, result.image)
      onFirstImage?.(result.image)
      const gate = deferred<void>()
      gates.set(src, gate)
      await gate.promise
      lateEarlyImage.push(() => onFirstImage?.(document.createElement('img')))
      // ... and the result carries the same image plus the thumbnail set.
      return result
    })
    const store = createCanvasStore()
    const sources = createSources(24)
    const { result } = renderIntake(store)

    let done = false
    await act(async () => {
      void result.current.addImagesToCanvas(sources).then(() => {
        done = true
      })
    })

    // The images being worked on already show their pixels; their sets are still to come.
    await waitFor(() =>
      expect(countRealPixels(store.items)).toBe(getCanvasImageStreamPixelConcurrency())
    )
    expect(
      store.images().filter((item) => item.image && item.image === earlyImages.get(item.src))
    ).toHaveLength(getCanvasImageStreamPixelConcurrency())
    expect(store.images().some((item) => item.thumbnailSet)).toBe(false)
    expect(store.historyCommits).toBe(1)

    for (let round = 0; round < 40 && !done; round += 1) {
      await act(async () => {
        ;[...gates.entries()].forEach(([src, gate]) => {
          gates.delete(src)
          gate.resolve()
        })
      })
      await new Promise((resolve) => setTimeout(resolve, 30))
    }
    await waitFor(() => expect(done).toBe(true), { timeout: 5000 })
    // An early image that arrives after the final patch must not replace anything.
    lateEarlyImage.forEach((emit) => emit())
    await new Promise((resolve) => setTimeout(resolve, 150))

    // Every frame kept the image it showed first (one upload per image) and got its set.
    expect(countRealPixels(store.items)).toBe(sources.length)
    expect(store.images().every((item) => item.image === earlyImages.get(item.src))).toBe(true)
    expect(store.images().every((item) => Boolean(item.thumbnailSet))).toBe(true)
    expect(store.historyCommits).toBe(1)
  })
})
