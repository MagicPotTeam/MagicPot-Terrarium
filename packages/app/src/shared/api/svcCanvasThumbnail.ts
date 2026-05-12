import { ServiceDefSheet } from './apiUtils/serviceDefSheet'

export type CanvasThumbnailSourceFileMetadataReq = {
  fullPath: string
}

export type CanvasThumbnailSourceFileMetadataResp = {
  exists: boolean
  canonicalPath: string
  sizeBytes: number
  lastModifiedMs: number
}

export type CanvasThumbnailCacheRootReq = {
  cacheRootDir?: string
}

export type CanvasThumbnailCacheRootResp = {
  cacheRoot: string
}

export type CanvasThumbnailManifestLevel = {
  maxSide: number
  filename: string
  src: string
  mimeType: 'image/webp' | 'image/png'
  width: number
  height: number
  sizeBytes: number
}

export type CanvasThumbnailManifest = {
  version: 1
  cacheKey: string
  canonicalPath: string
  sourceSizeBytes: number
  sourceLastModifiedMs: number
  levels: CanvasThumbnailManifestLevel[]
  createdAt: string
  updatedAt: string
}

export type CanvasThumbnailReadManifestReq = {
  cacheKey: string
  cacheRootDir?: string
}

export type CanvasThumbnailReadManifestResp = {
  manifest: CanvasThumbnailManifest | null
}

export type CanvasThumbnailWriteFile = {
  filename: string
  data: Uint8Array
}

export type CanvasThumbnailWriteSetReq = {
  cacheKey: string
  cacheRootDir?: string
  manifest: CanvasThumbnailManifest
  files: CanvasThumbnailWriteFile[]
}

export type CanvasThumbnailWriteSetResp = {
  manifest: CanvasThumbnailManifest
}

export type CanvasThumbnailNativeReq = {
  fullPath: string
  maxSide: number
}

export type CanvasThumbnailNativeResp = {
  data: Uint8Array
  width: number
  height: number
  mimeType: 'image/png'
}

export type CanvasThumbnailSvc = {
  getSourceFileMetadata(
    req: CanvasThumbnailSourceFileMetadataReq
  ): Promise<CanvasThumbnailSourceFileMetadataResp>
  getThumbnailCacheRoot(req?: CanvasThumbnailCacheRootReq): Promise<CanvasThumbnailCacheRootResp>
  readThumbnailManifest(
    req: CanvasThumbnailReadManifestReq
  ): Promise<CanvasThumbnailReadManifestResp>
  writeThumbnailSet(req: CanvasThumbnailWriteSetReq): Promise<CanvasThumbnailWriteSetResp>
  createNativeThumbnail(req: CanvasThumbnailNativeReq): Promise<CanvasThumbnailNativeResp>
}

export const canvasThumbnailSvcDef: ServiceDefSheet<CanvasThumbnailSvc> = {
  getSourceFileMetadata: {
    type: 'unary'
  },
  getThumbnailCacheRoot: {
    type: 'unary'
  },
  readThumbnailManifest: {
    type: 'unary'
  },
  writeThumbnailSet: {
    type: 'unary'
  },
  createNativeThumbnail: {
    type: 'unary'
  }
}
