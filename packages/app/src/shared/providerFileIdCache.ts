export type ProviderFileIdCacheKey = {
  provider: string
  accountIdentity: string
  contentIdentity: string
}

export type ProviderFileIdCacheValue = {
  fileId: string
  expiresAt?: number
}

export type ProviderFileIdCacheOptions = {
  maxEntries?: number
  now?: () => number
}

const DEFAULT_MAX_ENTRIES = 256

const serializeKey = (key: ProviderFileIdCacheKey): string =>
  JSON.stringify([key.provider, key.accountIdentity, key.contentIdentity])

export class ProviderFileIdCache {
  private readonly entries = new Map<string, ProviderFileIdCacheValue>()
  private readonly maxEntries: number
  private readonly now: () => number

  constructor(options: ProviderFileIdCacheOptions = {}) {
    const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES
    if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
      throw new RangeError('maxEntries must be a positive safe integer')
    }

    this.maxEntries = maxEntries
    this.now = options.now ?? Date.now
  }

  get(key: ProviderFileIdCacheKey): ProviderFileIdCacheValue | undefined {
    const serializedKey = serializeKey(key)
    const entry = this.entries.get(serializedKey)
    if (!entry) return undefined

    if (this.isExpired(entry)) {
      this.entries.delete(serializedKey)
      return undefined
    }

    this.entries.delete(serializedKey)
    this.entries.set(serializedKey, entry)
    return { ...entry }
  }

  set(key: ProviderFileIdCacheKey, value: ProviderFileIdCacheValue): void {
    const serializedKey = serializeKey(key)
    this.entries.delete(serializedKey)

    if (this.isExpired(value)) return

    this.pruneExpired()
    this.entries.set(serializedKey, { ...value })

    while (this.entries.size > this.maxEntries) {
      const leastRecentlyUsedKey = this.entries.keys().next().value
      if (leastRecentlyUsedKey === undefined) break
      this.entries.delete(leastRecentlyUsedKey)
    }
  }

  invalidate(key: ProviderFileIdCacheKey): boolean {
    return this.entries.delete(serializeKey(key))
  }

  clear(): void {
    this.entries.clear()
  }

  get size(): number {
    this.pruneExpired()
    return this.entries.size
  }

  private isExpired(value: ProviderFileIdCacheValue): boolean {
    return value.expiresAt !== undefined && value.expiresAt <= this.now()
  }

  private pruneExpired(): void {
    for (const [key, value] of this.entries) {
      if (this.isExpired(value)) this.entries.delete(key)
    }
  }
}
