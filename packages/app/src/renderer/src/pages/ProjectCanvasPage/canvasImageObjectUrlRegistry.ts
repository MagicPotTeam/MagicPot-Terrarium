export type CanvasImageObjectUrlHandle = {
  url: string
  revoke: () => void
}

export type CanvasImageObjectUrlRegistryMetrics = {
  activeCount: number
  activeBytes: number
  createdCount: number
  revokedCount: number
  rejectedCount: number
}

type ObjectUrlLease = {
  id: string
  url: string
}

type ObjectUrlEntry = {
  url: string
  byteSize: number
  leases: Set<ObjectUrlLease>
  transferableLease?: ObjectUrlLease
}

export const DEFAULT_MAX_OBJECT_URL_COUNT = 128

export class CanvasImageObjectUrlRegistry {
  private readonly entries = new Map<string, ObjectUrlEntry>()
  private readonly owners = new Map<string, ObjectUrlLease>()
  private readonly releasedUrls = new Set<string>()
  private maxCount = DEFAULT_MAX_OBJECT_URL_COUNT
  private createdCount = 0
  private revokedCount = 0
  private rejectedCount = 0

  getMaxCount(): number {
    return this.maxCount
  }

  setMaxCount(maxCount: number): number {
    const previous = this.maxCount
    this.maxCount =
      Number.isFinite(maxCount) && maxCount >= 0
        ? Math.floor(maxCount)
        : DEFAULT_MAX_OBJECT_URL_COUNT
    return previous
  }

  create(id: string, blob: Blob): CanvasImageObjectUrlHandle | null {
    if (this.owners.has(id) || this.entries.size >= this.maxCount) {
      this.rejectedCount += 1
      return null
    }

    const url = URL.createObjectURL(blob)
    const lease = { id, url }
    this.entries.set(url, {
      url,
      byteSize: Math.max(0, blob.size),
      leases: new Set([lease]),
      transferableLease: lease
    })
    this.owners.set(id, lease)
    this.releasedUrls.delete(url)
    this.createdCount += 1
    return this.createHandle(lease)
  }

  // The first adoption transfers the creator's lease (and invalidates its handle).
  // Subsequent adopters get independent leases; the URL budget counts allocations,
  // not leases. Only owned URLs may be passed here, never borrowed references.
  adopt(id: string, url: string, byteSize = 0): CanvasImageObjectUrlHandle | null {
    if (!url.startsWith('blob:') || this.releasedUrls.has(url)) return null
    let entry = this.entries.get(url)
    if (this.owners.has(id) || (!entry && this.entries.size >= this.maxCount)) {
      this.rejectedCount += 1
      if (!entry) {
        this.rememberReleasedUrl(url)
        this.revokedCount += 1
        URL.revokeObjectURL(url)
      }
      return null
    }
    if (!entry) {
      entry = {
        url,
        byteSize: Number.isFinite(byteSize) ? Math.max(0, byteSize) : 0,
        leases: new Set()
      }
      this.entries.set(url, entry)
    }
    const lease = { id, url }
    entry.leases.add(lease)
    this.owners.set(id, lease)
    if (entry.transferableLease) {
      this.owners.delete(entry.transferableLease.id)
      entry.leases.delete(entry.transferableLease)
      entry.transferableLease = undefined
    }
    return this.createHandle(lease)
  }

  private createHandle(lease: ObjectUrlLease): CanvasImageObjectUrlHandle {
    return {
      url: lease.url,
      revoke: () => {
        // Identity also protects a new lease that reuses an old owner's id.
        if (this.owners.get(lease.id) !== lease) return
        this.owners.delete(lease.id)
        const entry = this.entries.get(lease.url)
        if (!entry) return
        entry.leases.delete(lease)
        if (entry.leases.size === 0) this.revokeEntry(entry)
      }
    }
  }

  private rememberReleasedUrl(url: string): void {
    const historyLimit = Math.max(256, this.maxCount * 4)
    if (this.releasedUrls.size >= historyLimit) {
      const oldest = this.releasedUrls.values().next().value
      if (typeof oldest === 'string') {
        this.releasedUrls.delete(oldest)
      }
    }
    this.releasedUrls.add(url)
  }

  private revokeEntry(entry: ObjectUrlEntry): void {
    this.entries.delete(entry.url)
    entry.leases.forEach((lease) => this.owners.delete(lease.id))
    entry.leases.clear()
    this.rememberReleasedUrl(entry.url)
    this.revokedCount += 1
    URL.revokeObjectURL(entry.url)
  }

  // Explicit URL-wide disposal for canvas deletion/persistence and cancellation.
  // Lease owners must use their handle's revoke() for independent cleanup.
  release(url: string): boolean {
    const entry = this.entries.get(url)
    if (entry) {
      this.revokeEntry(entry)
      return true
    }
    return this.releasedUrls.has(url)
  }

  getMetrics(): CanvasImageObjectUrlRegistryMetrics {
    let activeBytes = 0
    this.entries.forEach((entry) => {
      activeBytes += entry.byteSize
    })
    return {
      activeCount: this.entries.size,
      activeBytes,
      createdCount: this.createdCount,
      revokedCount: this.revokedCount,
      rejectedCount: this.rejectedCount
    }
  }

  revokeAll(): void {
    Array.from(this.entries.values()).forEach((entry) => this.revokeEntry(entry))
  }
}

export const canvasImageObjectUrlRegistry = new CanvasImageObjectUrlRegistry()

export function createCanvasImageObjectUrlHandle(
  id: string,
  blob: Blob
): CanvasImageObjectUrlHandle | null {
  return canvasImageObjectUrlRegistry.create(id, blob)
}

export function adoptCanvasImageObjectUrlHandle(
  id: string,
  url: string,
  byteSize = 0
): CanvasImageObjectUrlHandle | null {
  return canvasImageObjectUrlRegistry.adopt(id, url, byteSize)
}

export function getCanvasImageObjectUrlRegistryMetrics(): CanvasImageObjectUrlRegistryMetrics {
  return canvasImageObjectUrlRegistry.getMetrics()
}

export function releaseCanvasImageObjectUrl(url: string): boolean {
  return canvasImageObjectUrlRegistry.release(url)
}

export function configureCanvasImageObjectUrlRegistry(maxCount: number): number {
  return canvasImageObjectUrlRegistry.setMaxCount(maxCount)
}
