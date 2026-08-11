export type CanvasImageStableSource = {
  src: string
  sourceIdentity?: { cacheKey: string } | null
  weakRevisionKey?: string | number | null
}

export function hasCanvasImageStrongSourceIdentity(source: CanvasImageStableSource): boolean {
  return Boolean(source.sourceIdentity?.cacheKey) || /^data:/i.test(source.src)
}

export function getCanvasImageStableSourceKey(source: CanvasImageStableSource): string | null {
  const identityKey = source.sourceIdentity?.cacheKey
  if (identityKey) return `identity:${identityKey}`
  if (/^(?:https?:|data:)/i.test(source.src)) return `src:${source.src}`
  return null
}

export function getCanvasImageSourceRevisionKey(source: CanvasImageStableSource): string {
  const weakRevisionKey = hasCanvasImageStrongSourceIdentity(source)
    ? null
    : (source.weakRevisionKey ?? null)
  return JSON.stringify([source.src, source.sourceIdentity?.cacheKey ?? null, weakRevisionKey])
}

export function getCanvasImageSharedDecodedAssetKey({
  source,
  variant
}: {
  source: CanvasImageStableSource
  variant: string
}): string | null {
  const sourceKey = getCanvasImageStableSourceKey(source)
  if (!sourceKey) return null
  const weakRevisionKey = hasCanvasImageStrongSourceIdentity(source)
    ? null
    : (source.weakRevisionKey ?? null)
  const revisionSuffix = weakRevisionKey === null ? '' : `|weak-revision:${weakRevisionKey}`
  return `${sourceKey}${revisionSuffix}|decoded-asset:${variant}`
}

export type CanvasImageRequestToken = Readonly<{
  itemId: string
  sourceRevisionKey: string
  sequence: number
}>

export class CanvasImageRequestTokenTracker {
  private readonly currentByItemId = new Map<string, CanvasImageRequestToken>()
  private nextSequence = 1

  begin(itemId: string, source: CanvasImageStableSource): CanvasImageRequestToken {
    const token = {
      itemId,
      sourceRevisionKey: getCanvasImageSourceRevisionKey(source),
      sequence: this.nextSequence
    }
    this.nextSequence += 1
    this.currentByItemId.set(itemId, token)
    return token
  }

  isCurrent(token: CanvasImageRequestToken, source: CanvasImageStableSource): boolean {
    return (
      this.currentByItemId.get(token.itemId) === token &&
      token.sourceRevisionKey === getCanvasImageSourceRevisionKey(source)
    )
  }

  invalidate(itemId: string) {
    this.currentByItemId.delete(itemId)
  }

  clear() {
    this.currentByItemId.clear()
  }
}

export function getCanvasImageDecodedRevisionKey({
  source,
  decodedIdentity
}: {
  source: CanvasImageStableSource
  decodedIdentity: string | number
}): string {
  return `${getCanvasImageStableSourceKey(source) ?? `unstable:${source.src}`}|decoded:${decodedIdentity}`
}

export class CanvasImageInFlightDeduper<T> {
  private readonly pending = new Map<string, Promise<T>>()

  run(key: string, load: () => Promise<T>): Promise<T> {
    const existing = this.pending.get(key)
    if (existing) return existing
    const promise = load().finally(() => {
      if (this.pending.get(key) === promise) this.pending.delete(key)
    })
    this.pending.set(key, promise)
    return promise
  }

  clear() {
    this.pending.clear()
  }
}

export class CanvasImageSharedResourcePool<T> {
  private readonly entries = new Map<string, { resource: T; refs: number }>()

  acquire(key: string, create: () => T): T {
    const existing = this.entries.get(key)
    if (existing) {
      existing.refs += 1
      return existing.resource
    }
    const resource = create()
    this.entries.set(key, { resource, refs: 1 })
    return resource
  }

  release(key: string, destroy: (resource: T) => void) {
    const entry = this.entries.get(key)
    if (!entry) return
    entry.refs -= 1
    if (entry.refs > 0) return
    this.entries.delete(key)
    destroy(entry.resource)
  }

  clear(destroy: (resource: T) => void) {
    this.entries.forEach(({ resource }) => destroy(resource))
    this.entries.clear()
  }

  getRefCount(key: string) {
    return this.entries.get(key)?.refs ?? 0
  }
}

export class CanvasImageSharedResourceByteTracker {
  private readonly entries = new Map<string, { bytes: number; refs: number }>()
  private total = 0

  acquire(key: string, bytes: number) {
    const existing = this.entries.get(key)
    if (existing) {
      existing.refs += 1
      return 0
    }
    const safeBytes = Number.isFinite(bytes) ? Math.max(0, bytes) : 0
    this.entries.set(key, { bytes: safeBytes, refs: 1 })
    this.total += safeBytes
    return safeBytes
  }

  release(key: string) {
    const entry = this.entries.get(key)
    if (!entry) return 0
    entry.refs -= 1
    if (entry.refs > 0) return 0
    this.entries.delete(key)
    this.total = Math.max(0, this.total - entry.bytes)
    return entry.bytes
  }

  getAdditionalBytes(key: string, bytes: number) {
    if (this.entries.has(key)) return 0
    return Number.isFinite(bytes) ? Math.max(0, bytes) : 0
  }

  getReleaseBytes(key: string) {
    const entry = this.entries.get(key)
    return entry?.refs === 1 ? entry.bytes : 0
  }

  getRefCount(key: string) {
    return this.entries.get(key)?.refs ?? 0
  }

  getTotal() {
    return this.total
  }

  clear() {
    this.entries.clear()
    this.total = 0
  }
}

export class CanvasImageSharedReservationTracker {
  private readonly refsByKey = new Map<string, number>()

  acquire(
    key: string,
    reserve: () => boolean,
    releaseReservation: () => void
  ): (() => void) | null {
    const existingRefs = this.refsByKey.get(key)
    if (existingRefs !== undefined) {
      this.refsByKey.set(key, existingRefs + 1)
    } else {
      if (!reserve()) return null
      this.refsByKey.set(key, 1)
    }

    let active = true
    return () => {
      if (!active) return
      active = false
      const refs = this.refsByKey.get(key)
      if (refs === undefined) return
      if (refs > 1) {
        this.refsByKey.set(key, refs - 1)
        return
      }
      this.refsByKey.delete(key)
      releaseReservation()
    }
  }

  clear(releaseReservation: (key: string) => void) {
    this.refsByKey.forEach((_refs, key) => releaseReservation(key))
    this.refsByKey.clear()
  }

  getRefCount(key: string) {
    return this.refsByKey.get(key) ?? 0
  }
}

export type CanvasImageSharedResourceLease<T> = {
  resource: T
  release: () => void
}

type CanvasImagePendingSharedResource<T> = {
  promise: Promise<T>
  refs: number
  abortController: AbortController
  resource?: T
  error?: unknown
  destroyed?: boolean
  listeners: Set<{
    resolve: (lease: CanvasImageSharedResourceLease<T>) => void
    reject: (error: unknown) => void
    release: () => void
  }>
}

export class CanvasImageAsyncSharedResourcePool<T> {
  private readonly entries = new Map<string, CanvasImagePendingSharedResource<T>>()

  acquireWithCallback(
    key: string,
    load: (signal: AbortSignal) => Promise<T>,
    destroy: (resource: T) => void,
    onLease: (lease: CanvasImageSharedResourceLease<T>) => void,
    onError: (error: unknown) => void
  ): () => void {
    let entry = this.entries.get(key)
    if (!entry) {
      const abortController = new AbortController()
      entry = {
        promise: load(abortController.signal),
        refs: 0,
        abortController,
        listeners: new Set()
      }
      this.entries.set(key, entry)
      void entry.promise.then(
        (resource) => {
          entry!.resource = resource
          entry!.listeners.forEach((listener) =>
            listener.resolve({ resource, release: listener.release })
          )
          entry!.listeners.clear()
          if (entry!.refs === 0 && !entry!.destroyed) {
            entry!.destroyed = true
            if (this.entries.get(key) === entry) this.entries.delete(key)
            destroy(resource)
          }
        },
        (error) => {
          entry!.error = error
          entry!.listeners.forEach((listener) => listener.reject(error))
          entry!.listeners.clear()
          if (this.entries.get(key) === entry) this.entries.delete(key)
        }
      )
    }

    entry.refs += 1
    let active = true
    const release = () => {
      if (!active) return
      active = false
      entry!.refs -= 1
      if (entry!.refs === 0 && entry!.resource !== undefined && !entry!.destroyed) {
        entry!.destroyed = true
        if (this.entries.get(key) === entry) this.entries.delete(key)
        destroy(entry!.resource)
      } else if (entry!.refs === 0 && entry!.resource === undefined) {
        if (this.entries.get(key) === entry) this.entries.delete(key)
        entry!.abortController.abort()
      }
    }

    if (entry.resource !== undefined) {
      onLease({ resource: entry.resource, release })
      return release
    }
    if (entry.error !== undefined) {
      release()
      onError(entry.error)
      return release
    }
    const listener = {
      resolve: onLease,
      reject: (error: unknown) => {
        release()
        onError(error)
      },
      release
    }
    entry.listeners.add(listener)
    return () => {
      entry?.listeners.delete(listener)
      release()
    }
  }

  acquire(key: string, load: (signal: AbortSignal) => Promise<T>, destroy: (resource: T) => void) {
    return new Promise<CanvasImageSharedResourceLease<T>>((resolve, reject) => {
      this.acquireWithCallback(key, load, destroy, resolve, reject)
    })
  }

  getRefCount(key: string) {
    return this.entries.get(key)?.refs ?? 0
  }
}

export function createTokenSafeRelease<TArgs extends unknown[]>(
  release: (...args: TArgs) => void
): (...args: TArgs) => void {
  let active = true
  return (...args: TArgs) => {
    if (!active) return
    active = false
    release(...args)
  }
}
