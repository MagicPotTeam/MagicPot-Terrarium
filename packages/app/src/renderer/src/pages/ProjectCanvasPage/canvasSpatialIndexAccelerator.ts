import type { CanvasSpatialBounds } from './canvasSpatialIndex'

const CANVAS_SPATIAL_INDEX_ACCELERATOR_MIN_ENTRIES = 1024
const WASM_MODULE_PATH = 'wasm/canvas_spatial_index/canvas_spatial_index.js'
const WASM_BINARY_PATH = 'wasm/canvas_spatial_index/canvas_spatial_index_bg.wasm'

type NativeSpatialIndex = {
  query: (queryBounds: Float64Array) => Uint32Array | number[]
  free?: () => void
}

type WasmSpatialIndexConstructor = new (
  flattenedBounds: Float64Array,
  cellSize: number,
  maxIndexedCellsPerEntry: number,
  maxQueryCells: number
) => NativeSpatialIndex

type WasmSpatialIndexModule = {
  default?: (moduleOrPath?: string | URL | Request) => Promise<unknown>
  SpatialIndex?: WasmSpatialIndexConstructor
}

export type CanvasSpatialIndexAcceleratorOptions = {
  cellSize: number
  maxIndexedCellsPerEntry: number
  maxQueryCells: number
}

export type CanvasSpatialIndexAccelerator = {
  readonly source: 'wasm' | 'test'
  queryIndexes: (queryBounds: CanvasSpatialBounds) => readonly number[] | Uint32Array | null
  dispose?: () => void
}

type CanvasSpatialIndexAcceleratorFactory = (
  flattenedBounds: Float64Array,
  options: CanvasSpatialIndexAcceleratorOptions
) => CanvasSpatialIndexAccelerator | null

let wasmModule: WasmSpatialIndexModule | null = null
let wasmLoadState: 'idle' | 'loading' | 'ready' | 'failed' = 'idle'
let wasmLoadPromise: Promise<void> | null = null
let testAcceleratorFactory: CanvasSpatialIndexAcceleratorFactory | null = null

const finalizationRegistry: FinalizationRegistry<NativeSpatialIndex> | null =
  typeof FinalizationRegistry === 'function'
    ? new FinalizationRegistry((nativeIndex) => {
        nativeIndex.free?.()
      })
    : null

const hasWasmRuntime = (): boolean =>
  typeof window !== 'undefined' && typeof WebAssembly !== 'undefined' && typeof fetch === 'function'

const loadWasmSpatialIndexModule = async (): Promise<void> => {
  if (!hasWasmRuntime()) {
    wasmLoadState = 'failed'
    return
  }

  try {
    const moduleUrl = new URL(WASM_MODULE_PATH, window.location.href).href
    const binaryUrl = new URL(WASM_BINARY_PATH, window.location.href).href
    const module = (await import(/* @vite-ignore */ moduleUrl)) as WasmSpatialIndexModule
    if (module.default) {
      await module.default(binaryUrl)
    }
    if (typeof module.SpatialIndex !== 'function') {
      throw new Error('canvas spatial index WASM module did not export SpatialIndex')
    }
    wasmModule = module
    wasmLoadState = 'ready'
  } catch {
    wasmModule = null
    wasmLoadState = 'failed'
  }
}

export const requestCanvasSpatialIndexAcceleratorWarmup = (): void => {
  if (testAcceleratorFactory || wasmLoadState !== 'idle') {
    return
  }

  wasmLoadState = 'loading'
  wasmLoadPromise = loadWasmSpatialIndexModule()
  void wasmLoadPromise
}

export const isCanvasSpatialIndexAcceleratorReady = (): boolean =>
  Boolean(testAcceleratorFactory) || wasmLoadState === 'ready'

export const shouldAttemptCanvasSpatialIndexAcceleration = (entryCount: number): boolean => {
  if (testAcceleratorFactory) {
    return true
  }
  if (entryCount >= CANVAS_SPATIAL_INDEX_ACCELERATOR_MIN_ENTRIES) {
    requestCanvasSpatialIndexAcceleratorWarmup()
  }
  return wasmLoadState === 'ready' && entryCount >= CANVAS_SPATIAL_INDEX_ACCELERATOR_MIN_ENTRIES
}

const boundsToFloat64Array = (bounds: CanvasSpatialBounds): Float64Array =>
  new Float64Array([bounds.minX, bounds.minY, bounds.maxX, bounds.maxY])

export const createCanvasSpatialIndexAccelerator = (
  flattenedBounds: Float64Array,
  options: CanvasSpatialIndexAcceleratorOptions
): CanvasSpatialIndexAccelerator | null => {
  if (testAcceleratorFactory) {
    return testAcceleratorFactory(flattenedBounds, options)
  }

  if (!wasmModule?.SpatialIndex) {
    requestCanvasSpatialIndexAcceleratorWarmup()
    return null
  }

  try {
    const nativeIndex = new wasmModule.SpatialIndex(
      flattenedBounds,
      options.cellSize,
      options.maxIndexedCellsPerEntry,
      options.maxQueryCells
    )
    let disposed = false
    const accelerator: CanvasSpatialIndexAccelerator = {
      source: 'wasm',
      queryIndexes: (queryBounds) => {
        if (disposed) return null
        return nativeIndex.query(boundsToFloat64Array(queryBounds))
      },
      dispose: () => {
        if (disposed) return
        disposed = true
        finalizationRegistry?.unregister(accelerator)
        nativeIndex.free?.()
      }
    }
    finalizationRegistry?.register(accelerator, nativeIndex, accelerator)
    return accelerator
  } catch {
    return null
  }
}

export const setCanvasSpatialIndexAcceleratorFactoryForTest = (
  factory: CanvasSpatialIndexAcceleratorFactory | null
): void => {
  testAcceleratorFactory = factory
}

export const resetCanvasSpatialIndexAcceleratorForTest = (): void => {
  testAcceleratorFactory = null
  wasmModule = null
  wasmLoadState = 'idle'
  wasmLoadPromise = null
}
