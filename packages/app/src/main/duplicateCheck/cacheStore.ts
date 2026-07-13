import fs from 'node:fs/promises'
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

const MAX_FILE_ENTRIES = 10_000
const MAX_BLOB_ENTRIES = 5_000

const normalizeFileKey = (fullPath: string): string =>
  path.resolve(fullPath).replace(/\\/g, '/').toLowerCase()

export class DuplicateCheckCacheStore {
  private readonly filePath: string
  private loaded = false
  private dirty = false
  private data: DuplicateCheckCacheData = EMPTY_CACHE_DATA
  private loadPromise: Promise<void> | null = null
  private savePromise: Promise<void> = Promise.resolve()
  private revision = 0

  constructor(cacheRootDir: string) {
    this.filePath = path.join(cacheRootDir, 'duplicate-check-cache.json')
  }

  private ensureLoaded(): Promise<void> {
    if (this.loaded) return Promise.resolve()

    this.loadPromise ??= (async () => {
      try {
        const parsed = JSON.parse(
          await fs.readFile(this.filePath, 'utf8')
        ) as DuplicateCheckCacheData
        if (parsed?.version === 2) {
          this.data = {
            version: 2,
            blobs: parsed.blobs || {},
            files: parsed.files || {}
          }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          console.warn('[DuplicateCheckCacheStore] Failed to load cache:', error)
        }
        this.data = { ...EMPTY_CACHE_DATA, blobs: {}, files: {} }
      } finally {
        this.loaded = true
      }
    })()
    return this.loadPromise
  }

  async getBlob(sha256: string): Promise<CachedBlobFeatureEntry | null> {
    await this.ensureLoaded()
    return this.data.blobs[sha256] || null
  }

  async getFile(
    fullPath: string,
    size: number,
    mtimeMs: number
  ): Promise<CachedBlobFeatureEntry | null> {
    await this.ensureLoaded()
    const fileEntry = this.data.files[normalizeFileKey(fullPath)]
    if (!fileEntry || fileEntry.size !== size || fileEntry.mtimeMs !== mtimeMs) return null
    return this.data.blobs[fileEntry.sha256] || null
  }

  async upsertBlob(entry: CachedBlobFeatureEntry): Promise<void> {
    await this.ensureLoaded()
    this.data.blobs[entry.sha256] = entry
    this.dirty = true
    this.revision += 1
  }

  async upsertFile(fullPath: string, size: number, mtimeMs: number, sha256: string): Promise<void> {
    await this.ensureLoaded()
    this.data.files[normalizeFileKey(fullPath)] = {
      fullPath,
      size,
      mtimeMs,
      sha256,
      updatedAt: new Date().toISOString()
    }
    this.dirty = true
    this.revision += 1
  }

  private prune(): void {
    const newest = <T extends { updatedAt: string }>(entries: Array<[string, T]>, limit: number) =>
      entries
        .sort(([, left], [, right]) => right.updatedAt.localeCompare(left.updatedAt))
        .slice(0, limit)

    this.data.files = Object.fromEntries(newest(Object.entries(this.data.files), MAX_FILE_ENTRIES))
    const referencedBlobs = new Set(Object.values(this.data.files).map((entry) => entry.sha256))
    const blobs = newest(Object.entries(this.data.blobs), MAX_BLOB_ENTRIES)
    const retainedBlobKeys = new Set(blobs.map(([key]) => key))
    for (const sha256 of referencedBlobs) {
      const blob = this.data.blobs[sha256]
      if (!retainedBlobKeys.has(sha256) && blob) blobs.push([sha256, blob])
    }
    this.data.blobs = Object.fromEntries(blobs)
  }

  async save(): Promise<void> {
    await this.ensureLoaded()
    this.savePromise = this.savePromise
      .catch(() => undefined)
      .then(async () => {
        if (!this.dirty) return
        this.prune()
        const savedRevision = this.revision
        const serialized = JSON.stringify(this.data)
        const tempPath = `${this.filePath}.${process.pid}.${crypto.randomUUID()}.tmp`
        await fs.mkdir(path.dirname(this.filePath), { recursive: true })
        try {
          await fs.writeFile(tempPath, serialized, 'utf8')
          await fs.rename(tempPath, this.filePath)
          if (this.revision === savedRevision) this.dirty = false
        } finally {
          await fs.rm(tempPath, { force: true }).catch(() => undefined)
        }
      })
    return this.savePromise
  }
}
