import type {
  CanvasSpatialTileAddress,
  CanvasSpatialTileDescriptor,
  CanvasSpatialTileGeometry,
  CanvasSpatialTileRect
} from './canvasSpatialTileTypes'

export type CanvasSpatialTileOutputFormat = 'image/webp' | 'image/png'

export type CanvasSpatialTileBrowserCropRequest = {
  source: Blob
  descriptor: Pick<CanvasSpatialTileDescriptor, 'sourceWidth' | 'sourceHeight'>
  geometry: CanvasSpatialTileGeometry
  scaleDenominator: number
  preferWebp?: boolean
  nativeRegionRequest?: CanvasSpatialTileNativeRegionRequest
}

export type CanvasSpatialTileBrowserCropMessage = {
  type: 'generate-browser-crop'
  requestId: string
  source: Blob
  sourceWidth: number
  sourceHeight: number
  geometry: CanvasSpatialTileGeometry
  scaleDenominator: number
  preferWebp: boolean
}

export type CanvasSpatialTileBrowserCropResult = {
  blob: Blob
  mimeType: CanvasSpatialTileOutputFormat
  width: number
  height: number
  contentRectInBitmap: CanvasSpatialTileRect
  geometry: CanvasSpatialTileGeometry
}

export type CanvasSpatialTileBrowserCropSuccessMessage = {
  type: 'success'
  requestId: string
  result: CanvasSpatialTileBrowserCropResult
}

export type CanvasSpatialTileBrowserCropErrorMessage = {
  type: 'error'
  requestId: string
  error: string
}

export type CanvasSpatialTileWorkerMessage =
  CanvasSpatialTileBrowserCropSuccessMessage | CanvasSpatialTileBrowserCropErrorMessage

export type CanvasSpatialTileNativeCapabilityRequest = {
  sourcePath: string
  sourceIdentityCacheKey: string
  sourceWidth: number
  sourceHeight: number
  tileKey: string
  address: CanvasSpatialTileAddress
  descriptorVersion: number
  tileSize: number
  gutter: number
  geometry: CanvasSpatialTileGeometry
  scaleDenominator: number
  format?: CanvasSpatialTileOutputFormat
}

export type CanvasSpatialTileNativeCapabilityResult = {
  supported: false
  reason: 'unsupported'
}

export type CanvasSpatialTileNativeCapability = (
  request: CanvasSpatialTileNativeCapabilityRequest
) => Promise<CanvasSpatialTileNativeCapabilityResult>

export type CanvasSpatialTileNativeRegionRequest = {
  sourcePath: string
  allowedRoots: string[]
  sourceWidth?: number
  sourceHeight?: number
  x: number
  y: number
  width: number
  height: number
  outputWidth?: number
  outputHeight?: number
  maxOutputPixels: number
  maxOutputBytes: number
  timeoutMs: number
  cacheRoot: string
  includeBase64?: boolean
}

export type CanvasSpatialTileNativeRegionResult = {
  cacheKey: string
  cachePath: string
  sourcePath: string
  sourceWidth: number
  sourceHeight: number
  requestedRect: { x: number; y: number; width: number; height: number }
  outputWidth: number
  outputHeight: number
  outputBytes: number
  mimeType: 'image/png'
  data: Uint8Array
  base64?: string
}

export type CanvasSpatialTileNativeRegionBackend = (
  request: CanvasSpatialTileNativeRegionRequest,
  signal?: AbortSignal
) => Promise<CanvasSpatialTileNativeRegionResult>

function assertNativeRegionResultWithinBudget(
  result: {
    data: Uint8Array
    sourceWidth: number
    sourceHeight: number
    x: number
    y: number
    width: number
    height: number
    outputWidth: number
    outputHeight: number
  },
  request: CanvasSpatialTileNativeRegionRequest,
  maxOutputPixels: number,
  maxOutputBytes: number
): void {
  const dimensions = [
    ['sourceWidth', result.sourceWidth],
    ['sourceHeight', result.sourceHeight],
    ['x', result.x],
    ['y', result.y],
    ['width', result.width],
    ['height', result.height],
    ['outputWidth', result.outputWidth],
    ['outputHeight', result.outputHeight]
  ] as const
  for (const [name, value] of dimensions) {
    if (!Number.isSafeInteger(value) || value < 0 || (name !== 'x' && name !== 'y' && value <= 0)) {
      throw new Error(`Native region bridge returned invalid ${name}.`)
    }
  }

  const requestedRect = [request.x, request.y, request.width, request.height]
  const returnedRect = [result.x, result.y, result.width, result.height]
  if (requestedRect.some((value, index) => value !== returnedRect[index])) {
    throw new Error('Native region bridge returned a different crop rectangle.')
  }

  const outputPixels = result.outputWidth * result.outputHeight
  if (!Number.isSafeInteger(outputPixels) || outputPixels > maxOutputPixels) {
    throw new Error('Native region bridge output exceeds the pixel budget.')
  }
  if (result.data.byteLength > maxOutputBytes) {
    throw new Error('Native region bridge output exceeds the byte budget.')
  }
}

export type CanvasSpatialTileNativeRegionBridge = (request: {
  fullPath: string
  x: number
  y: number
  width: number
  height: number
  outputWidth?: number
  outputHeight?: number
  maxOutputPixels?: number
  maxOutputBytes?: number
}) => Promise<{
  data: Uint8Array
  sourceWidth: number
  sourceHeight: number
  x: number
  y: number
  width: number
  height: number
  outputWidth: number
  outputHeight: number
  mimeType: 'image/png'
} | null>

export function createCanvasSpatialTileNativeRegionBackendFromThumbnailBridge(
  bridge: {
    createNativeRegion?: CanvasSpatialTileNativeRegionBridge
  },
  options: {
    sourcePath: string
    maxOutputPixels: number
    maxOutputBytes: number
  }
): CanvasSpatialTileNativeRegionBackend | null {
  if (!bridge.createNativeRegion) {
    return null
  }
  const configuredSourcePath = options.sourcePath.trim() || null
  return async (request, signal) => {
    if (signal?.aborted) {
      throw new DOMException('Native region request cancelled.', 'AbortError')
    }
    const createNativeRegion = bridge.createNativeRegion
    if (!createNativeRegion) {
      throw new Error('Native region bridge is unavailable.')
    }
    const requestedSourcePath = request.sourcePath.trim()
    if (!requestedSourcePath) {
      throw new Error('Native region request source path is required.')
    }
    if (configuredSourcePath && requestedSourcePath !== configuredSourcePath) {
      throw new Error('Native region request source path does not match the configured source.')
    }
    const sourcePath = requestedSourcePath
    const result = await createNativeRegion({
      fullPath: sourcePath,
      x: request.x,
      y: request.y,
      width: request.width,
      height: request.height,
      ...(request.outputWidth !== undefined ? { outputWidth: request.outputWidth } : {}),
      ...(request.outputHeight !== undefined ? { outputHeight: request.outputHeight } : {}),
      maxOutputPixels: Math.min(request.maxOutputPixels, options.maxOutputPixels),
      maxOutputBytes: Math.min(request.maxOutputBytes, options.maxOutputBytes)
    })
    if (!result) {
      throw new Error('Native region backend returned no result.')
    }
    const maxOutputPixels = Math.min(request.maxOutputPixels, options.maxOutputPixels)
    const maxOutputBytes = Math.min(request.maxOutputBytes, options.maxOutputBytes)
    assertNativeRegionResultWithinBudget(result, request, maxOutputPixels, maxOutputBytes)
    if (signal?.aborted) {
      throw new DOMException('Native region request cancelled.', 'AbortError')
    }
    return {
      cacheKey: `ipc:${sourcePath}:${request.x}:${request.y}:${request.width}:${request.height}`,
      cachePath: '',
      sourcePath,
      sourceWidth: result.sourceWidth,
      sourceHeight: result.sourceHeight,
      requestedRect: { x: result.x, y: result.y, width: result.width, height: result.height },
      outputWidth: result.outputWidth,
      outputHeight: result.outputHeight,
      outputBytes: result.data.byteLength,
      mimeType: 'image/png',
      data: result.data
    }
  }
}
