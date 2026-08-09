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
  | CanvasSpatialTileBrowserCropSuccessMessage
  | CanvasSpatialTileBrowserCropErrorMessage

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
