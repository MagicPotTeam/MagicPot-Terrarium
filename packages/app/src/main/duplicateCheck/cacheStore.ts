import fs from 'fs'
import path from 'path'

type CachedEmbeddingEntry = {
  embedding: number[]
  robustEmbedding?: number[]
  provider?: string
  updatedAt: string
}

export type CachedBlobFeatureEntry = {
  sha256: string
  width: number
  height: number
  dHash: string
  pHash: string
  embeddings: Record<string, CachedEmbeddingEntry>
  updatedAt: string
}

type CachedFileIndexEntry = {
  fullPath: string
  size: number
  mtimeMs: number
  sha256: string
  updatedAt: string
}

type DuplicateCheckCacheData = {
  version: 2
  blobs: Record<string, CachedBlobFeatureEntry>
  files: Record<string, CachedFileIndexEntry>
}

const EMPTY_CACHE_DATA: DuplicateCheckCacheData = {
  version: 2,
  blobs: {},
  files: {}
}

const normalizeFileKey = (fullPath: string): string =>
  path.resolve(fullPath).replace(/\\/g, '/').toLowerCase()

export class DuplicateCheckCacheStore {
  private readonly filePath: string

  private loaded = false

  private dirty = false

  private data: DuplicateCheckCacheData = EMPTY_CACHE_DATA

  constructor(cacheRootDir: string) {
    this.filePath = path.join(cacheRootDir, 'duplicate-check-cache.json')
  }

  private ensureLoaded(): void {
    if (this.loaded) {
      return
    }

    this.loaded = true

    try {
      if (!fs.existsSync(this.filePath)) {
        this.data = { ...EMPTY_CACHE_DATA, blobs: {}, files: {} }
        return
      }

      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as DuplicateCheckCacheData
      if (!parsed || parsed.version !== 2) {
        this.data = { ...EMPTY_CACHE_DATA, blobs: {}, files: {} }
        return
      }

      this.data = {
        version: 2,
        blobs: parsed.blobs || {},
        files: parsed.files || {}
      }
    } catch {
      this.data = { ...EMPTY_CACHE_DATA, blobs: {}, files: {} }
    }
  }

  getBlob(sha256: string): CachedBlobFeatureEntry | null {
    this.ensureLoaded()
    return this.data.blobs[sha256] || null
  }

  getFile(fullPath: string, size: number, mtimeMs: number): CachedBlobFeatureEntry | null {
    this.ensureLoaded()
    const fileEntry = this.data.files[normalizeFileKey(fullPath)]
    if (!fileEntry) {
      return null
    }

    if (fileEntry.size !== size || fileEntry.mtimeMs !== mtimeMs) {
      return null
    }

    return this.data.blobs[fileEntry.sha256] || null
  }

  upsertBlob(entry: CachedBlobFeatureEntry): void {
    this.ensureLoaded()
    this.data.blobs[entry.sha256] = entry
    this.dirty = true
  }

  upsertFile(fullPath: string, size: number, mtimeMs: number, sha256: string): void {
    this.ensureLoaded()
    this.data.files[normalizeFileKey(fullPath)] = {
      fullPath,
      size,
      mtimeMs,
      sha256,
      updatedAt: new Date().toISOString()
    }
    this.dirty = true
  }

  save(): void {
    this.ensureLoaded()
    if (!this.dirty) {
      return
    }

    fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    fs.writeFileSync(this.filePath, JSON.stringify(this.data), 'utf8')
    this.dirty = false
  }
}
