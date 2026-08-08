export const SPATIAL_TILE_RESOURCE_MANAGER_VERSION = 2

export type SpatialTileResourceKind = 'imageBitmap' | 'blobUrl' | 'webglTexture'
export type SpatialTileResourceOwnership = 'owned' | 'borrowed'

/** Static tile metadata belongs to the caller/cache; the manager never stores it. */
export type SpatialTileDescriptor = {
  tileKey: string
  generation: number
  level?: number
}

export type SpatialTileImageBitmapLike = {
  close: () => void
}

export type SpatialTileRuntimeAsset = {
  imageBitmap?: SpatialTileImageBitmapLike
  blobUrl?: string
  webglTexture?: unknown
  imageBitmapOwnership?: SpatialTileResourceOwnership
  blobUrlOwnership?: SpatialTileResourceOwnership
  webglTextureOwnership?: SpatialTileResourceOwnership
}

export type SpatialTileRequestToken = SpatialTileDescriptor

export type SpatialTileResourceManagerOptions = {
  revokeBlobUrl?: (url: string) => void
  deleteWebGLTexture?: (texture: unknown) => void
}

export type SpatialTileResourceManagerMetrics = {
  version: typeof SPATIAL_TILE_RESOURCE_MANAGER_VERSION
  activeTileCount: number
  activeResourceCount: number
  activeImageBitmapCount: number
  activeBlobUrlCount: number
  activeWebGLTextureCount: number
  closedImageBitmapCount: number
  revokedBlobUrlCount: number
  deletedWebGLTextureCount: number
  generationCount: number
}

type OwnedRuntimeResource = {
  kind: SpatialTileResourceKind
  value: SpatialTileImageBitmapLike | string | unknown
}

type TileEntry = {
  generation: number
  resources: Map<SpatialTileResourceKind, OwnedRuntimeResource>
}

const defaultRevokeBlobUrl = (url: string) => {
  if (typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
    URL.revokeObjectURL(url)
  }
}

export class SpatialTileResourceManager {
  private readonly entries = new Map<string, TileEntry>()
  private readonly revokeBlobUrl: (url: string) => void
  private readonly deleteWebGLTexture: (texture: unknown) => void
  private closedImageBitmapCount = 0
  private revokedBlobUrlCount = 0
  private deletedWebGLTextureCount = 0
  private generationCount = 0

  constructor(options: SpatialTileResourceManagerOptions = {}) {
    this.revokeBlobUrl = options.revokeBlobUrl ?? defaultRevokeBlobUrl
    this.deleteWebGLTexture = options.deleteWebGLTexture ?? (() => undefined)
  }

  beginRequest(descriptor: SpatialTileDescriptor): SpatialTileRequestToken {
    const entry = this.entries.get(descriptor.tileKey)
    if (entry && descriptor.generation < entry.generation) {
      return { ...descriptor }
    }

    if (entry && descriptor.generation > entry.generation) {
      this.releaseEntry(entry)
    }
    this.entries.set(descriptor.tileKey, {
      generation: descriptor.generation,
      resources: entry && descriptor.generation === entry.generation ? entry.resources : new Map()
    })
    this.generationCount += 1
    return { ...descriptor }
  }

  isCurrent(token: SpatialTileRequestToken): boolean {
    return this.entries.get(token.tileKey)?.generation === token.generation
  }

  commit(token: SpatialTileRequestToken, asset: SpatialTileRuntimeAsset): boolean {
    const entry = this.entries.get(token.tileKey)
    if (!entry || entry.generation !== token.generation) {
      this.releaseAsset(asset)
      return false
    }

    const nextResources = this.toOwnedResources(asset)
    for (const resource of nextResources) {
      const previous = entry.resources.get(resource.kind)
      if (previous) {
        this.releaseResource(previous)
      }
      entry.resources.set(resource.kind, resource)
    }
    return true
  }

  releaseTile(tileKey: string, generation?: number): boolean {
    const entry = this.entries.get(tileKey)
    if (!entry || (generation !== undefined && entry.generation !== generation)) {
      return false
    }

    this.releaseEntry(entry)
    this.entries.delete(tileKey)
    this.generationCount += 1
    return true
  }

  clear(): void {
    for (const tileKey of Array.from(this.entries.keys())) {
      this.releaseTile(tileKey)
    }
  }

  getMetricsSnapshot(): SpatialTileResourceManagerMetrics {
    let activeResourceCount = 0
    let activeImageBitmapCount = 0
    let activeBlobUrlCount = 0
    let activeWebGLTextureCount = 0

    for (const entry of this.entries.values()) {
      activeResourceCount += entry.resources.size
      activeImageBitmapCount += Number(entry.resources.has('imageBitmap'))
      activeBlobUrlCount += Number(entry.resources.has('blobUrl'))
      activeWebGLTextureCount += Number(entry.resources.has('webglTexture'))
    }

    return {
      version: SPATIAL_TILE_RESOURCE_MANAGER_VERSION,
      activeTileCount: this.entries.size,
      activeResourceCount,
      activeImageBitmapCount,
      activeBlobUrlCount,
      activeWebGLTextureCount,
      closedImageBitmapCount: this.closedImageBitmapCount,
      revokedBlobUrlCount: this.revokedBlobUrlCount,
      deletedWebGLTextureCount: this.deletedWebGLTextureCount,
      generationCount: this.generationCount
    }
  }

  private toOwnedResources(asset: SpatialTileRuntimeAsset): OwnedRuntimeResource[] {
    const resources: OwnedRuntimeResource[] = []
    if (asset.imageBitmap && asset.imageBitmapOwnership !== 'borrowed') {
      resources.push({ kind: 'imageBitmap', value: asset.imageBitmap })
    }
    if (asset.blobUrl && asset.blobUrlOwnership !== 'borrowed') {
      resources.push({ kind: 'blobUrl', value: asset.blobUrl })
    }
    if (asset.webglTexture && asset.webglTextureOwnership !== 'borrowed') {
      resources.push({ kind: 'webglTexture', value: asset.webglTexture })
    }
    return resources
  }

  private releaseEntry(entry: TileEntry): void {
    for (const resource of entry.resources.values()) {
      this.releaseResource(resource)
    }
    entry.resources.clear()
  }

  private releaseAsset(asset: SpatialTileRuntimeAsset): void {
    for (const resource of this.toOwnedResources(asset)) {
      this.releaseResource(resource)
    }
  }

  private releaseResource(resource: OwnedRuntimeResource): void {
    if (resource.kind === 'imageBitmap') {
      ;(resource.value as SpatialTileImageBitmapLike).close()
      this.closedImageBitmapCount += 1
      return
    }
    if (resource.kind === 'blobUrl') {
      this.revokeBlobUrl(String(resource.value))
      this.revokedBlobUrlCount += 1
      return
    }
    this.deleteWebGLTexture(resource.value)
    this.deletedWebGLTextureCount += 1
  }
}

export function createSpatialTileResourceManager(
  options?: SpatialTileResourceManagerOptions
): SpatialTileResourceManager {
  return new SpatialTileResourceManager(options)
}
