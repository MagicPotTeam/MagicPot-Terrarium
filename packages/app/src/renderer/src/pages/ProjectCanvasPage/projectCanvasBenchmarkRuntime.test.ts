import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  hasProjectCanvasRealBoardBenchmarkRuntime,
  installProjectCanvasBenchmarkViewportSetter,
  readProjectCanvasBenchmarkImportTotalSize,
  readProjectCanvasBenchmarkSharedThumbnailCacheRoot,
  type ProjectCanvasBenchmarkViewportSetter
} from './projectCanvasBenchmarkRuntime'

type TestBenchmarkWindow = Window & {
  magicpotProjectCanvasBenchmarkRuntime?: Readonly<{
    enabled: boolean
    canvasImportTotalSize?: number
    sharedThumbnailCacheRoot?: string
  }>
  __MAGICPOT_REAL_BOARD_CANVAS_IMPORT_TOTAL_SIZE__?: unknown
  __MAGICPOT_REAL_BOARD_SHARED_THUMBNAIL_CACHE_ROOT__?: unknown
  __MAGICPOT_REAL_BOARD_SET_PROJECT_CANVAS_VIEWPORT__?: ProjectCanvasBenchmarkViewportSetter
}

function getTestBenchmarkWindow(): TestBenchmarkWindow {
  return window as TestBenchmarkWindow
}

function installTestBenchmarkWindow(): TestBenchmarkWindow {
  const benchmarkWindow = {} as TestBenchmarkWindow
  vi.stubGlobal('window', benchmarkWindow)
  return benchmarkWindow
}

function defineBenchmarkRuntime(
  runtime: TestBenchmarkWindow['magicpotProjectCanvasBenchmarkRuntime'],
  descriptor: Partial<PropertyDescriptor> = {}
): void {
  Object.defineProperty(getTestBenchmarkWindow(), 'magicpotProjectCanvasBenchmarkRuntime', {
    value: runtime,
    configurable: false,
    enumerable: true,
    writable: false,
    ...descriptor
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('projectCanvasBenchmarkRuntime', () => {
  it('does not authorize benchmark controls from legacy mutable window globals alone', () => {
    const benchmarkWindow = installTestBenchmarkWindow()
    benchmarkWindow.__MAGICPOT_REAL_BOARD_CANVAS_IMPORT_TOTAL_SIZE__ = 123
    benchmarkWindow.__MAGICPOT_REAL_BOARD_SHARED_THUMBNAIL_CACHE_ROOT__ = '/tmp/cache'

    expect(hasProjectCanvasRealBoardBenchmarkRuntime()).toBe(false)
    expect(readProjectCanvasBenchmarkImportTotalSize()).toBe(0)
    expect(readProjectCanvasBenchmarkSharedThumbnailCacheRoot()).toBeUndefined()

    const setter = vi.fn(() => ({ scale: 1, x: 0, y: 0 }))
    const cleanup = installProjectCanvasBenchmarkViewportSetter(setter)
    expect(benchmarkWindow.__MAGICPOT_REAL_BOARD_SET_PROJECT_CANVAS_VIEWPORT__).toBeUndefined()
    cleanup()
  })

  it('ignores benchmark hint values when the immutable preload runtime gate is disabled', () => {
    installTestBenchmarkWindow()
    defineBenchmarkRuntime({
      enabled: false,
      canvasImportTotalSize: 123,
      sharedThumbnailCacheRoot: '/tmp/cache'
    })

    expect(hasProjectCanvasRealBoardBenchmarkRuntime()).toBe(false)
    expect(readProjectCanvasBenchmarkImportTotalSize()).toBe(0)
    expect(readProjectCanvasBenchmarkSharedThumbnailCacheRoot()).toBeUndefined()
  })

  it('does not trust a mutable renderer-created benchmark runtime property', () => {
    installTestBenchmarkWindow()
    defineBenchmarkRuntime(
      {
        enabled: true,
        canvasImportTotalSize: 123,
        sharedThumbnailCacheRoot: '/tmp/cache'
      },
      { configurable: true, writable: true }
    )

    expect(hasProjectCanvasRealBoardBenchmarkRuntime()).toBe(false)
    expect(readProjectCanvasBenchmarkImportTotalSize()).toBe(0)
    expect(readProjectCanvasBenchmarkSharedThumbnailCacheRoot()).toBeUndefined()
  })

  it('reads benchmark hints and installs viewport controls only when the preload runtime gate is enabled', () => {
    const benchmarkWindow = installTestBenchmarkWindow()
    defineBenchmarkRuntime({
      enabled: true,
      canvasImportTotalSize: 123.9,
      sharedThumbnailCacheRoot: '/tmp/cache'
    })

    expect(hasProjectCanvasRealBoardBenchmarkRuntime()).toBe(true)
    expect(readProjectCanvasBenchmarkImportTotalSize()).toBe(123)
    expect(readProjectCanvasBenchmarkSharedThumbnailCacheRoot()).toBe('/tmp/cache')

    const setter = vi.fn(() => ({ scale: 2, x: 10, y: 20 }))
    const cleanup = installProjectCanvasBenchmarkViewportSetter(setter)

    expect(benchmarkWindow.__MAGICPOT_REAL_BOARD_SET_PROJECT_CANVAS_VIEWPORT__).toBe(setter)
    expect(
      benchmarkWindow.__MAGICPOT_REAL_BOARD_SET_PROJECT_CANVAS_VIEWPORT__?.({ scale: 2 })
    ).toEqual({
      scale: 2,
      x: 10,
      y: 20
    })

    cleanup()
    expect(benchmarkWindow.__MAGICPOT_REAL_BOARD_SET_PROJECT_CANVAS_VIEWPORT__).toBeUndefined()
  })
})
