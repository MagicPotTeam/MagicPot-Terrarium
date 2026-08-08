import type { CanvasSpatialTileAddress } from './canvasSpatialTileTypes'

export const CANVAS_SPATIAL_TILE_RESOURCE_MANAGER_VERSION = 1

export type CanvasSpatialTileResourceOwnership = 'owned' | 'borrowed'

export type CanvasSpatialTileResourceRequest = {
  tileKey: string
  address?: CanvasSpatialTileAddress
  sourceKey?: string
  level?: number
  config?: string
  generation: number
}

export type CanvasSpatialTileImageBitmapLike = {
  close: () => void
}

export type CanvasSpatialTileReleasableAsset = {
  value?: unknown
  dispose: () => void
}

export type CanvasSpatialTileRuntimeAsset = {
  value?: unknown
  imageBitmap?: CanvasSpatialTileImageBitmapLike
  releasable?: CanvasSpatialTileReleasableAsset
  disposables?: readonly (() => void)[]
  ownership?: CanvasSpatialTileResourceOwnership
}

type StoredAsset = {
  value?: unknown
  dispose: () => void
}

type TileEntry = {
  sourceKey?: string
  level?: number
  config?: string
  generation: number
  asset?: StoredAsset
}

export type CanvasSpatialTileResourceManagerOptions = {
  onDisposeError?: (error: unknown, tileKey: string) => void
}

export type CanvasSpatialTileResourceManagerMetrics = {
  version: typeof CANVAS_SPATIAL_TILE_RESOURCE_MANAGER_VERSION
  activeTileCount: number
  activeAssetCount: number
  disposedAssetCount: number
  generationCount: number
  disposeErrorCount: number
}

export class CanvasSpatialTileResourceManager {
  private readonly entries = new Map<string, TileEntry>()
  private readonly onDisposeError?: (error: unknown, tileKey: string) => void
  private disposedAssetCount = 0
  private generationCount = 0
  private disposeErrorCount = 0

  constructor(options: CanvasSpatialTileResourceManagerOptions = {}) {
    this.onDisposeError = options.onDisposeError
  }

  begin(request: CanvasSpatialTileResourceRequest): CanvasSpatialTileResourceRequest {
    const current = this.entries.get(request.tileKey)
    if (current && request.generation < current.generation) {
      return { ...request }
    }

    if (current && request.generation === current.generation) {
      if (
        current.sourceKey !== request.sourceKey ||
        current.level !== request.level ||
        current.config !== request.config
      ) {
        this.disposeEntry(request.tileKey, current)
        current.sourceKey = request.sourceKey
        current.level = request.level
        current.config = request.config
      }
      return { ...request }
    }

    if (current) {
      this.disposeEntry(request.tileKey, current)
    }

    this.entries.set(request.tileKey, {
      sourceKey: request.sourceKey,
      level: request.level,
      config: request.config,
      generation: request.generation
    })
    this.generationCount += 1
    return { ...request }
  }

  isCurrent(request: CanvasSpatialTileResourceRequest): boolean {
    const current = this.entries.get(request.tileKey)
    return current?.generation === request.generation
  }

  commit(request: CanvasSpatialTileResourceRequest, asset: CanvasSpatialTileRuntimeAsset): boolean {
    const current = this.entries.get(request.tileKey)
    const storedAsset = this.toStoredAsset(asset)
    if (!current || current.generation !== request.generation) {
      if (storedAsset) {
        this.disposeAsset(request.tileKey, storedAsset)
      }
      return false
    }

    if (current.asset) {
      this.disposeAsset(request.tileKey, current.asset)
    }
    current.asset = storedAsset
    return true
  }

  getCurrentAsset(request: CanvasSpatialTileResourceRequest): unknown | undefined {
    const current = this.entries.get(request.tileKey)
    if (!current || current.generation !== request.generation) {
      return undefined
    }
    return current.asset?.value
  }

  invalidateTile(tileKey: string, generation?: number): boolean {
    const current = this.entries.get(tileKey)
    if (!current || (generation !== undefined && current.generation !== generation)) {
      return false
    }
    this.disposeEntry(tileKey, current)
    this.entries.delete(tileKey)
    this.generationCount += 1
    return true
  }

  invalidateSourceLevel(sourceKey: string, level: number, generation?: number): string[] {
    const invalidated: string[] = []
    for (const [tileKey, entry] of this.entries) {
      if (
        entry.sourceKey === sourceKey &&
        entry.level === level &&
        (generation === undefined || entry.generation <= generation)
      ) {
        this.disposeEntry(tileKey, entry)
        this.entries.delete(tileKey)
        invalidated.push(tileKey)
      }
    }
    if (invalidated.length > 0) {
      this.generationCount += invalidated.length
    }
    return invalidated
  }

  clear(): void {
    for (const tileKey of Array.from(this.entries.keys())) {
      this.invalidateTile(tileKey)
    }
  }

  getMetricsSnapshot(): CanvasSpatialTileResourceManagerMetrics {
    let activeAssetCount = 0
    for (const entry of this.entries.values()) {
      activeAssetCount += Number(Boolean(entry.asset))
    }
    return {
      version: CANVAS_SPATIAL_TILE_RESOURCE_MANAGER_VERSION,
      activeTileCount: this.entries.size,
      activeAssetCount,
      disposedAssetCount: this.disposedAssetCount,
      generationCount: this.generationCount,
      disposeErrorCount: this.disposeErrorCount
    }
  }

  private toStoredAsset(asset: CanvasSpatialTileRuntimeAsset): StoredAsset | undefined {
    const value = asset.releasable?.value ?? asset.value ?? asset.imageBitmap
    if (asset.ownership === 'borrowed') {
      return value === undefined ? undefined : { value, dispose: () => undefined }
    }
    if (asset.disposables && asset.disposables.length > 0) {
      const disposables = asset.disposables.map((dispose) => () => dispose())
      return { value, dispose: () => disposables.forEach((dispose) => dispose()) }
    }
    if (asset.releasable) {
      return { value, dispose: () => asset.releasable?.dispose() }
    }
    if (asset.imageBitmap) {
      return { value, dispose: () => asset.imageBitmap?.close() }
    }
    return value === undefined ? undefined : { value, dispose: () => undefined }
  }

  private disposeEntry(tileKey: string, entry: TileEntry): void {
    if (entry.asset) {
      this.disposeAsset(tileKey, entry.asset)
      entry.asset = undefined
    }
  }

  private disposeAsset(tileKey: string, asset: StoredAsset): void {
    try {
      asset.dispose()
    } catch (error) {
      this.disposeErrorCount += 1
      this.onDisposeError?.(error, tileKey)
    } finally {
      this.disposedAssetCount += 1
    }
  }
}

export function createCanvasSpatialTileResourceManager(
  options?: CanvasSpatialTileResourceManagerOptions
): CanvasSpatialTileResourceManager {
  return new CanvasSpatialTileResourceManager(options)
}
