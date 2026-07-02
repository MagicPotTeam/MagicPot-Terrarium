export type ProjectCanvasBenchmarkViewportSetter = (
  viewport:
    | {
        scale?: number
        x?: number
        y?: number
        focusLargestImage?: boolean
        selectFocused?: boolean
      }
    | null
    | undefined
) => { scale: number; x: number; y: number; focusedImageId?: string }

type ProjectCanvasBenchmarkRuntimeBridge = Readonly<{
  enabled: boolean
  canvasImportTotalSize?: number
  sharedThumbnailCacheRoot?: string
}>

type ProjectCanvasBenchmarkWindow = Window & {
  magicpotProjectCanvasBenchmarkRuntime?: ProjectCanvasBenchmarkRuntimeBridge
  __MAGICPOT_REAL_BOARD_SET_PROJECT_CANVAS_VIEWPORT__?: ProjectCanvasBenchmarkViewportSetter
}

function getBenchmarkWindow(): ProjectCanvasBenchmarkWindow | null {
  if (typeof window === 'undefined') {
    return null
  }

  return window as ProjectCanvasBenchmarkWindow
}

function isTrustedProjectCanvasBenchmarkRuntime(
  runtime: ProjectCanvasBenchmarkRuntimeBridge | undefined,
  descriptor: PropertyDescriptor | undefined
): runtime is ProjectCanvasBenchmarkRuntimeBridge & { enabled: true } {
  if (runtime?.enabled !== true || !descriptor) {
    return false
  }

  return (
    Object.prototype.hasOwnProperty.call(descriptor, 'value') &&
    descriptor.value === runtime &&
    descriptor.writable === false &&
    descriptor.configurable === false
  )
}

function getProjectCanvasBenchmarkRuntime(): ProjectCanvasBenchmarkRuntimeBridge | null {
  const benchmarkWindow = getBenchmarkWindow()
  if (!benchmarkWindow) {
    return null
  }

  const runtime = benchmarkWindow.magicpotProjectCanvasBenchmarkRuntime
  const descriptor = Object.getOwnPropertyDescriptor(
    benchmarkWindow,
    'magicpotProjectCanvasBenchmarkRuntime'
  )
  return isTrustedProjectCanvasBenchmarkRuntime(runtime, descriptor) ? runtime : null
}

export function hasProjectCanvasRealBoardBenchmarkRuntime(): boolean {
  return getProjectCanvasBenchmarkRuntime() !== null
}

export function readProjectCanvasBenchmarkImportTotalSize(): number {
  const value = getProjectCanvasBenchmarkRuntime()?.canvasImportTotalSize
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

export function readProjectCanvasBenchmarkSharedThumbnailCacheRoot(): string | undefined {
  const value = getProjectCanvasBenchmarkRuntime()?.sharedThumbnailCacheRoot
  return typeof value === 'string' && value.trim() ? value : undefined
}

export function installProjectCanvasBenchmarkViewportSetter(
  setter: ProjectCanvasBenchmarkViewportSetter
): () => void {
  const benchmarkWindow = getBenchmarkWindow()
  if (!benchmarkWindow || !hasProjectCanvasRealBoardBenchmarkRuntime()) {
    return () => undefined
  }

  Object.defineProperty(benchmarkWindow, '__MAGICPOT_REAL_BOARD_SET_PROJECT_CANVAS_VIEWPORT__', {
    value: setter,
    configurable: true,
    enumerable: false,
    writable: false
  })

  return () => {
    const descriptor = Object.getOwnPropertyDescriptor(
      benchmarkWindow,
      '__MAGICPOT_REAL_BOARD_SET_PROJECT_CANVAS_VIEWPORT__'
    )
    if (descriptor?.value === setter) {
      delete benchmarkWindow.__MAGICPOT_REAL_BOARD_SET_PROJECT_CANVAS_VIEWPORT__
    }
  }
}
