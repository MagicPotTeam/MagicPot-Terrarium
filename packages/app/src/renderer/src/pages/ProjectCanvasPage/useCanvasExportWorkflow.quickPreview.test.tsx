import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runWithCanvasRasterWorkLimit } from './canvasRasterWorkLimiter'
import {
  createCanvasProvenCropRegistry,
  type CanvasProvenCropRegistry
} from './canvasProvenCropRegistry'
import { useCanvasExportWorkflow } from './useCanvasExportWorkflow'
import type { CanvasImageCropSource, CanvasImageItem, CanvasItem } from './types'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))
vi.mock('../../utils/windowUtils', () => ({ api: () => ({}) }))
vi.mock('./canvasStorage', () => ({
  exportCanvasFile: vi.fn(),
  exportCanvasFileAsStandalone: vi.fn()
}))

type LoadedImage = { img: HTMLImageElement; width: number; height: number }
type WorkflowOptions = Parameters<typeof useCanvasExportWorkflow>[0]

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function createImageItem(id: string, overrides: Partial<CanvasImageItem> = {}): CanvasImageItem {
  return {
    id,
    type: 'image',
    src: `local-media:///C:/images/${id}.png`,
    x: 100,
    y: 80,
    width: 120,
    height: 160,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 0,
    locked: false,
    ...overrides
  }
}

// The URL a stub registry hands out for one exact crop of one exact source.
function provenUrl(item: CanvasImageItem): string {
  const crop = item.crop!
  return `blob:proven-${item.id}-${item.src.split('/').pop()}-${crop.x}-${crop.y}-${crop.width}-${crop.height}`
}

// A registry that has an entry for every crop (the pixel content is not modelled).
function createStubRegistry(): CanvasProvenCropRegistry {
  return {
    register: () => null,
    lookup: (item) =>
      item.crop
        ? {
            url: provenUrl(item),
            fileName: `${item.id}-crop.png`,
            mimeType: 'image/png',
            sizeBytes: 16,
            width: item.crop.width,
            height: item.crop.height
          }
        : null,
    has: (item) => Boolean(item.crop),
    canAddWithoutEviction: () => true,
    beginPending: () => () => undefined,
    isPending: () => false,
    release: () => undefined,
    subscribe: () => () => undefined,
    entryCount: 0,
    totalBytes: 0
  }
}

function createLoadedImage(src: string): LoadedImage {
  const img = document.createElement('img')
  img.src = src
  return { img, width: 1024, height: 1024 }
}

function createContext(canvas: HTMLCanvasElement) {
  return {
    canvas,
    drawImage: vi.fn<(source: CanvasImageSource, ...coordinates: number[]) => void>(),
    save: vi.fn(),
    restore: vi.fn(),
    translate: vi.fn(),
    rotate: vi.fn(),
    scale: vi.fn(),
    fillRect: vi.fn()
  }
}

type RecordedContext = ReturnType<typeof createContext>
let contexts: Map<HTMLCanvasElement, RecordedContext>
let previewCanvases: Map<string, HTMLCanvasElement>
let blobCanvases: WeakMap<Blob, HTMLCanvasElement>
let createObjectURL: ReturnType<typeof vi.fn<(blob: Blob) => string>>
let revokeObjectURL: ReturnType<typeof vi.fn<(url: string) => void>>
const originalCreateObjectURL = Object.getOwnPropertyDescriptor(URL, 'createObjectURL')
const originalRevokeObjectURL = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL')

beforeEach(() => {
  contexts = new Map()
  previewCanvases = new Map()
  blobCanvases = new WeakMap()
  createObjectURL = vi.fn((blob: Blob) => {
    const url = `blob:quick-preview-${previewCanvases.size + 1}`
    const canvas = blobCanvases.get(blob)
    if (!canvas) throw new Error('Expected a blob rendered from the preview canvas')
    previewCanvases.set(url, canvas)
    return url
  })
  revokeObjectURL = vi.fn()
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    writable: true,
    value: createObjectURL
  })
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    writable: true,
    value: revokeObjectURL
  })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (
    this: HTMLCanvasElement
  ) {
    let context = contexts.get(this)
    if (!context) {
      context = createContext(this)
      contexts.set(this, context)
    }
    return context as unknown as CanvasRenderingContext2D
  } as unknown as typeof HTMLCanvasElement.prototype.getContext)
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (
    this: HTMLCanvasElement,
    callback: BlobCallback,
    type?: string
  ) {
    const blob = new Blob(['recorded-preview'], { type: type || 'image/png' })
    blobCanvases.set(blob, this)
    callback(blob)
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  if (originalCreateObjectURL) {
    Object.defineProperty(URL, 'createObjectURL', originalCreateObjectURL)
  } else {
    Reflect.deleteProperty(URL, 'createObjectURL')
  }
  if (originalRevokeObjectURL) {
    Object.defineProperty(URL, 'revokeObjectURL', originalRevokeObjectURL)
  } else {
    Reflect.deleteProperty(URL, 'revokeObjectURL')
  }
})

function renderWorkflow(items: CanvasItem[], overrides: Partial<WorkflowOptions> = {}) {
  const container = document.createElement('div')
  const webglLayer = document.createElement('div')
  webglLayer.className = 'project-canvas-webgl-layer'
  const webglCanvas = document.createElement('canvas')
  webglCanvas.width = 1600
  webglCanvas.height = 1200
  webglCanvas.style.width = '800px'
  webglCanvas.style.height = '600px'
  webglLayer.append(webglCanvas)
  container.append(webglLayer)
  const loadImageFromSrc = vi.fn(async (src: string) => createLoadedImage(src))
  const options: WorkflowOptions = {
    canvasId: 'canvas-preview-test',
    projectName: 'Quick preview test',
    items,
    groups: [],
    groupBranches: [],
    figmaBinding: null,
    selectedIds: new Set(items.map((item) => item.id)),
    setSelectedIds: vi.fn(),
    stageRef: { current: null },
    canvasContainerRef: { current: container },
    stagePos: { x: 180, y: -40 },
    stageScale: 0.5,
    bgColor: '#123456',
    loadImageFromSrc,
    getCanvasItemVisualBounds: (item) => ({
      x: item.x,
      y: item.y,
      width: item.width,
      height: item.height
    }),
    notifyError: vi.fn(() => 0),
    notifySuccess: vi.fn(() => 0),
    ...overrides
  }
  return {
    ...renderHook((props: WorkflowOptions) => useCanvasExportWorkflow(props), {
      initialProps: options
    }),
    options,
    webglCanvas,
    loadImageFromSrc
  }
}

function previewContext(url: string | null): RecordedContext {
  expect(url).not.toBeNull()
  const canvas = previewCanvases.get(url!)
  expect(canvas).toBeDefined()
  return contexts.get(canvas!)!
}

function drawnSources(context: RecordedContext): CanvasImageSource[] {
  return context.drawImage.mock.calls.map(([source]) => source)
}

describe('useCanvasExportWorkflow quick drag previews', () => {
  it('renders only selected group images instead of cropping the 2x WebGL viewport', async () => {
    const back = createImageItem('selected-back', { zIndex: 1 })
    const front = createImageItem('selected-front', { x: 180, zIndex: 3 })
    const overlappingNeighbor = createImageItem('unselected-neighbor', { zIndex: 9 })
    const { result, loadImageFromSrc, webglCanvas, options } = renderWorkflow(
      [back, overlappingNeighbor, front],
      { selectedIds: new Set([back.id, front.id]) }
    )
    let url: string | null = null
    await act(async () => {
      url = await result.current.prepareQuickCanvasItemsImageUrl([front, back])
    })

    expect(loadImageFromSrc.mock.calls.map(([src]) => src)).toEqual([back.src, front.src])
    const context = previewContext(url)
    expect(drawnSources(context).map((source) => (source as HTMLImageElement).src)).toEqual([
      back.src,
      front.src
    ])
    expect(drawnSources(context)).not.toContain(webglCanvas)
    expect(context.canvas.width).toBe(200)
    expect(context.canvas.height).toBe(160)
    expect(context.fillRect).not.toHaveBeenCalled()
    expect(options.setSelectedIds).not.toHaveBeenCalled()
  })

  it('draws a crop from its registered PNG with flip, rotation and z-order kept', async () => {
    // Before F2 the crop was redrawn from the original source (16, 24, 48, 72 of
    // item.src); it now comes only from the PNG registered when it was proven.
    const back = createImageItem('back', { zIndex: 1 })
    const front = createImageItem('cropped-front', {
      crop: { x: 16, y: 24, width: 48, height: 72 },
      rotation: 90,
      scaleX: -1,
      scaleY: 2,
      zIndex: 4
    })
    const { result, loadImageFromSrc } = renderWorkflow([front, back], {
      provenCropRegistry: createStubRegistry()
    })
    let url: string | null = null
    await act(async () => {
      url = await result.current.prepareQuickCanvasItemsImageUrl([front, back])
    })

    const context = previewContext(url)
    expect(loadImageFromSrc.mock.calls.map(([src]) => src)).toEqual([back.src, provenUrl(front)])
    const [backImage, frontImage] = await Promise.all(
      loadImageFromSrc.mock.results.map((call) => call.value as Promise<LoadedImage>)
    )
    expect(context.drawImage.mock.calls).toEqual([
      [backImage.img, 0, 0, 120, 160],
      [frontImage.img, 0, 0, 120, 160]
    ])
    expect(context.rotate).toHaveBeenCalledExactlyOnceWith(Math.PI / 2)
    expect(context.scale.mock.calls).toEqual([
      [1, 1],
      [-1, 2]
    ])
    expect(context.save).toHaveBeenCalledTimes(2)
    expect(context.restore).toHaveBeenCalledTimes(2)
  })

  it('keeps delayed A and newly selected B in their own source and crop cache entries', async () => {
    const item = createImageItem('same-item', {
      crop: { x: 10, y: 20, width: 30, height: 40 }
    })
    const original = { ...item, crop: { ...item.crop! } }
    const imageA = createLoadedImage(provenUrl(original))
    const readyA = deferred<LoadedImage>()
    const loadImageFromSrc = vi.fn((src: string) =>
      src === provenUrl(original) ? readyA.promise : Promise.resolve(createLoadedImage(src))
    )
    const { result, rerender, options } = renderWorkflow([item], {
      loadImageFromSrc,
      provenCropRegistry: createStubRegistry()
    })
    let urlA: string | null = null
    let urlB: string | null = null
    await act(async () => {
      const pendingA = result.current.prepareQuickCanvasItemsImageUrl([item])
      await Promise.resolve()
      await Promise.resolve()
      item.src = 'local-media:///C:/images/replacement-B.png'
      item.crop!.x = 70
      item.rotation = 180
      rerender({ ...options, items: [item] })
      const pendingB = result.current.prepareQuickCanvasItemsImageUrl([item])
      readyA.resolve(imageA)
      ;[urlA, urlB] = await Promise.all([pendingA, pendingB])
    })

    expect(urlA).not.toBe(urlB)
    expect(previewContext(urlA).drawImage.mock.calls).toEqual([[imageA.img, 0, 0, 120, 160]])
    const contextB = previewContext(urlB)
    expect((drawnSources(contextB)[0] as HTMLImageElement).src).toBe(provenUrl(item))
    expect(contextB.drawImage.mock.calls[0].slice(1)).toEqual([0, 0, 120, 160])
    expect(contextB.rotate).toHaveBeenCalledExactlyOnceWith(Math.PI)
    expect(result.current.getQuickCanvasItemsImageUrl([original])).toBe(urlA)
    expect(result.current.getQuickCanvasItemsImageUrl([item])).toBe(urlB)
  })

  it('snapshots the target array and nested crop before waiting in the raster work queue', async () => {
    const item = createImageItem('queued-A', {
      crop: { x: 1, y: 2, width: 3, height: 4 }
    })
    const original = { ...item, crop: { ...item.crop! } }
    const targets: CanvasItem[] = [item]
    const queueGate = deferred<void>()
    const blocker = runWithCanvasRasterWorkLimit(() => queueGate.promise)
    const { result, loadImageFromSrc } = renderWorkflow(targets, {
      provenCropRegistry: createStubRegistry()
    })
    let url: string | null = null
    await act(async () => {
      const pending = result.current.prepareQuickCanvasItemsImageUrl(targets)
      item.src = 'local-media:///C:/images/mutated-A.png'
      item.crop!.width = 999
      targets.splice(0, 1, createImageItem('unselected-B'))
      queueGate.resolve()
      ;[, url] = await Promise.all([blocker, pending])
    })

    expect(loadImageFromSrc).toHaveBeenCalledExactlyOnceWith(provenUrl(original))
    const context = previewContext(url)
    expect(context.drawImage.mock.calls[0].slice(1)).toEqual([0, 0, 120, 160])
    expect(result.current.getQuickCanvasItemsImageUrl([original])).toBe(url)
    expect(result.current.getQuickCanvasItemsImageUrl(targets)).toBeNull()
  })

  it('keeps the original export bounds when live selection bounds change while queued', async () => {
    const item = createImageItem('moving-selection')
    let liveBounds = { x: 100, y: 80, width: 120, height: 160 }
    const queueGate = deferred<void>()
    const blocker = runWithCanvasRasterWorkLimit(() => queueGate.promise)
    const { result } = renderWorkflow([item], {
      getCanvasItemVisualBounds: () => liveBounds
    })
    let url: string | null = null
    await act(async () => {
      const pending = result.current.prepareQuickCanvasItemsImageUrl([item])
      liveBounds = { x: 900, y: 700, width: 20, height: 30 }
      queueGate.resolve()
      ;[, url] = await Promise.all([blocker, pending])
    })

    const context = previewContext(url)
    expect(context.canvas.width).toBe(120)
    expect(context.canvas.height).toBe(160)
    expect(context.translate).toHaveBeenCalledExactlyOnceWith(0, 0)
  })

  it('does not reuse the opposite stacking order for images with equal z-index', async () => {
    const first = createImageItem('z-last-alphabetically')
    const second = createImageItem('a-first-alphabetically')
    const { result } = renderWorkflow([first, second])
    let forward: string | null = null
    let reverse: string | null = null
    await act(async () => {
      forward = await result.current.prepareQuickCanvasItemsImageUrl([first, second])
      reverse = await result.current.prepareQuickCanvasItemsImageUrl([second, first])
    })

    expect(forward).not.toBe(reverse)
    expect(
      drawnSources(previewContext(forward)).map((source) => (source as HTMLImageElement).src)
    ).toEqual([first.src, second.src])
    expect(
      drawnSources(previewContext(reverse)).map((source) => (source as HTMLImageElement).src)
    ).toEqual([second.src, first.src])
  })

  it('reuses identical pending and completed previews without reloading their image', async () => {
    const item = createImageItem('reused')
    const loaded = deferred<LoadedImage>()
    const loadImageFromSrc = vi.fn(() => loaded.promise)
    const { result } = renderWorkflow([item], { loadImageFromSrc })
    let urls: Array<string | null> = []
    await act(async () => {
      const first = result.current.prepareQuickCanvasItemsImageUrl([item])
      const second = result.current.prepareQuickCanvasItemsImageUrl([{ ...item }])
      loaded.resolve(createLoadedImage(item.src))
      urls = await Promise.all([first, second])
      urls.push(await result.current.prepareQuickCanvasItemsImageUrl([item]))
    })

    expect(urls[0]).not.toBeNull()
    expect(urls).toEqual([urls[0], urls[0], urls[0]])
    expect(loadImageFromSrc).toHaveBeenCalledExactlyOnceWith(item.src)
    expect(createObjectURL).toHaveBeenCalledTimes(1)
  })

  it('discards the old canvas pending result and prepares a new canvas preview independently', async () => {
    const item = createImageItem('same-source-on-two-canvases')
    const loaded = deferred<LoadedImage>()
    const loadImageFromSrc = vi
      .fn<(src: string) => Promise<LoadedImage>>()
      .mockImplementationOnce(() => loaded.promise)
      .mockImplementation(async (src) => createLoadedImage(src))
    const { result, rerender, options } = renderWorkflow([item], { loadImageFromSrc })
    const getOldPreview = result.current.getQuickCanvasItemsImageUrl
    let pending!: Promise<string | null>
    await act(async () => {
      pending = result.current.prepareQuickCanvasItemsImageUrl([item])
      await Promise.resolve()
      await Promise.resolve()
    })
    act(() => rerender({ ...options, canvasId: 'different-canvas' }))
    let nextUrl: string | null = null
    await act(async () => {
      loaded.resolve(createLoadedImage(item.src))
      await pending
      nextUrl = await result.current.prepareQuickCanvasItemsImageUrl([item])
    })

    expect(getOldPreview([item])).toBeNull()
    expect(nextUrl).not.toBeNull()
    expect(result.current.getQuickCanvasItemsImageUrl([item])).toBe(nextUrl)
    expect(loadImageFromSrc).toHaveBeenCalledTimes(2)
    for (const url of previewCanvases.keys()) {
      if (url !== nextUrl) expect(revokeObjectURL).toHaveBeenCalledWith(url)
    }
  })

  it('returns null for an empty or failed preview and retries the same source without stale cache', async () => {
    const item = createImageItem('retry')
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const loadImageFromSrc = vi
      .fn<(src: string) => Promise<LoadedImage>>()
      .mockRejectedValueOnce(new Error('Image temporarily unavailable'))
      .mockImplementation(async (src) => createLoadedImage(src))
    const { result } = renderWorkflow([item], { loadImageFromSrc })
    let empty: string | null = null
    let failed: string | null = null
    await act(async () => {
      empty = await result.current.prepareQuickCanvasItemsImageUrl([])
      failed = await result.current.prepareQuickCanvasItemsImageUrl([item])
    })
    expect(empty).toBeNull()
    expect(failed).toBeNull()
    expect(result.current.getQuickCanvasItemsImageUrl([item])).toBeNull()
    expect(createObjectURL).not.toHaveBeenCalled()
    expect(warning).toHaveBeenCalledTimes(1)
    let retried: string | null = null
    await act(async () => {
      retried = await result.current.prepareQuickCanvasItemsImageUrl([item])
    })
    expect(retried).not.toBeNull()
    expect(loadImageFromSrc).toHaveBeenCalledTimes(2)
    expect(result.current.getQuickCanvasItemsImageUrl([item])).toBe(retried)
  })

  it('does not repopulate preview cache or leak an object URL after unmount during preparation', async () => {
    const item = createImageItem('unmounted')
    const loaded = deferred<LoadedImage>()
    const loadImageFromSrc = vi.fn(() => loaded.promise)
    const { result, unmount } = renderWorkflow([item], { loadImageFromSrc })
    const getCachedPreview = result.current.getQuickCanvasItemsImageUrl
    await act(async () => {
      const pending = result.current.prepareQuickCanvasItemsImageUrl([item])
      await Promise.resolve()
      await Promise.resolve()
      unmount()
      loaded.resolve(createLoadedImage(item.src))
      await pending
    })

    expect(getCachedPreview([item])).toBeNull()
    for (const url of previewCanvases.keys()) {
      expect(revokeObjectURL).toHaveBeenCalledWith(url)
    }
  })
  describe('selections that hold a crop (F2 part 1)', () => {
    const SHA = 'a'.repeat(64)
    const record: CanvasImageCropSource = {
      version: 1,
      origin: 'confirm',
      width: 400,
      height: 300,
      sizeBytes: 1234,
      sha256: SHA
    }
    function croppedItem(id: string, overrides: Partial<CanvasImageItem> = {}): CanvasImageItem {
      return createImageItem(id, {
        src: `local-media:///C:/images/${id}.png`,
        sourceWidth: 400,
        sourceHeight: 300,
        crop: { x: 40, y: 30, width: 120, height: 160 },
        cropSource: record,
        zIndex: 2,
        ...overrides
      })
    }
    function realRegistry() {
      let made = 0
      return createCanvasProvenCropRegistry(
        {},
        { create: () => `blob:registered-crop-${++made}`, revoke: () => undefined }
      )
    }
    const png = () => new Blob(['crop-pixels'], { type: 'image/png' })

    it('makes no snapshot of a proven crop that has no registered PNG and never loads its source', async () => {
      const plain = createImageItem('plain-neighbour', { x: 300 })
      const cropped = croppedItem('unregistered-crop')
      const { result, loadImageFromSrc } = renderWorkflow([plain, cropped], {
        provenCropRegistry: realRegistry()
      })
      let url: string | null = 'not-called'
      await act(async () => {
        url = await result.current.prepareQuickCanvasItemsImageUrl([plain, cropped])
      })

      expect(url).toBeNull()
      expect(result.current.getQuickCanvasItemsImageUrl([plain, cropped])).toBeNull()
      expect(loadImageFromSrc).not.toHaveBeenCalled()
      expect(createObjectURL).not.toHaveBeenCalled()
    })

    it('makes no snapshot of a cropped selection without a registry', async () => {
      const cropped = croppedItem('no-registry-crop')
      const { result, loadImageFromSrc } = renderWorkflow([cropped])
      let url: string | null = 'not-called'
      await act(async () => {
        url = await result.current.prepareQuickCanvasItemsImageUrl([cropped])
      })
      expect(url).toBeNull()
      expect(loadImageFromSrc).not.toHaveBeenCalled()
    })

    it('draws the registered crop PNG, not item.src, even after the source file changed under the same URL', async () => {
      const plain = createImageItem('plain-beside-crop', { x: 300, zIndex: 1 })
      const cropped = croppedItem('registered-crop')
      const registry = realRegistry()
      const entry = registry.register(cropped, png(), { width: 120, height: 160 })
      expect(entry?.url).toBe('blob:registered-crop-1')
      // The local file behind cropped.src now holds other pixels: loading it
      // would give an image of a different size and content.
      const loadImageFromSrc = vi.fn(async (src: string) =>
        src === cropped.src
          ? { img: createLoadedImage('overwritten').img, width: 2048, height: 2048 }
          : createLoadedImage(src)
      )
      const { result } = renderWorkflow([plain, cropped], {
        loadImageFromSrc,
        provenCropRegistry: registry
      })
      let url: string | null = null
      await act(async () => {
        url = await result.current.prepareQuickCanvasItemsImageUrl([plain, cropped])
      })

      expect(loadImageFromSrc.mock.calls.map(([src]) => src)).toEqual([
        plain.src,
        'blob:registered-crop-1'
      ])
      const context = previewContext(url)
      const drawn = context.drawImage.mock.calls
      expect(drawn[1][0]).toEqual(expect.objectContaining({ src: 'blob:registered-crop-1' }))
      // Whole registered PNG into the item's own box: no crop rectangle is applied.
      expect(drawn[1].slice(1)).toEqual([0, 0, 120, 160])
      expect(result.current.getQuickCanvasItemsImageUrl([plain, cropped])).toBe(url)
    })

    it('stops serving the snapshot once the crop no longer matches its registered PNG', async () => {
      const cropped = croppedItem('changed-after-snapshot')
      const registry = realRegistry()
      registry.register(cropped, png(), { width: 120, height: 160 })
      const { result } = renderWorkflow([cropped], { provenCropRegistry: registry })
      let url: string | null = null
      await act(async () => {
        url = await result.current.prepareQuickCanvasItemsImageUrl([cropped])
      })
      expect(url).not.toBeNull()

      const recropped = { ...cropped, crop: { x: 0, y: 0, width: 100, height: 100 } }
      expect(result.current.getQuickCanvasItemsImageUrl([recropped])).toBeNull()
      const replaced = { ...cropped, src: 'local-media:///C:/images/replaced.png' }
      expect(result.current.getQuickCanvasItemsImageUrl([replaced])).toBeNull()
    })

    it('prepares the selection again when a selected crop gets its PNG', async () => {
      const plain = createImageItem('selected-plain', { x: 300 })
      const cropped = croppedItem('selected-late-crop')
      const registry = realRegistry()
      const { result } = renderWorkflow([plain, cropped], {
        provenCropRegistry: registry,
        selectedIds: new Set([plain.id, cropped.id])
      })
      const before = result.current.prepareQuickCanvasItemsImageUrl
      const unrelated = croppedItem('unselected-crop')
      act(() => {
        registry.register(unrelated, png(), { width: 120, height: 160 })
      })
      expect(result.current.prepareQuickCanvasItemsImageUrl).toBe(before)
      act(() => {
        registry.register(cropped, png(), { width: 120, height: 160 })
      })
      expect(result.current.prepareQuickCanvasItemsImageUrl).not.toBe(before)
      let url: string | null = null
      await act(async () => {
        url = await result.current.prepareQuickCanvasItemsImageUrl([plain, cropped])
      })
      expect(url).not.toBeNull()
    })
  })
})
