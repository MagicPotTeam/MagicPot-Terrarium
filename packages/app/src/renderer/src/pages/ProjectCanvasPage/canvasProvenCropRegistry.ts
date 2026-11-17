// packages/app/src/renderer/src/pages/ProjectCanvasPage/canvasProvenCropRegistry.ts
// The drawn pixels of proven crops, for sinks that cannot read and hash a
// source themselves (a drag start is synchronous). An entry is made only from
// bytes whose size, SHA-256 and decoded size matched the item's record: the
// background record after a crop confirm, or a successful Agent send. It is
// found again only for the same item id, source, record and crop. Only the
// cropped pixels are held, as small PNG Blobs behind canvas-owned object URLs;
// the registry is bounded and released with the board.
import {
  canvasPngDataUrlToBlob,
  getCanvasImageCropPngFileName,
  type CanvasProvenCropPixels
} from './canvasAgentAttachmentUtils'
import { hasVerifiableCrop } from './canvasCropProvenance'
import { normalizeCanvasImageDisplayCrop } from './canvasImageDisplayUtils'
import type { CanvasImageItem, CanvasItem } from './types'

export const CANVAS_PROVEN_CROP_REGISTRY_MAX_ENTRIES = 24
export const CANVAS_PROVEN_CROP_REGISTRY_MAX_BYTES = 64 * 1024 * 1024
export const CANVAS_PROVEN_CROP_ENTRY_MAX_BYTES = 32 * 1024 * 1024
/**
 * Crops above this many output pixels are not drawn for the registry: their
 * PNG would rarely fit CANVAS_PROVEN_CROP_ENTRY_MAX_BYTES, and the decode,
 * readback and encode would be thrown away.
 */
export const CANVAS_PROVEN_CROP_DRAW_MAX_PIXELS = 4096 * 4096

/** Whether the registry would draw this proven crop at all (pixel cap). */
export function isCanvasProvenCropDrawable(item: CanvasImageItem): boolean {
  const size = getCanvasProvenCropOutputSize(item)
  return Boolean(size && size.width * size.height <= CANVAS_PROVEN_CROP_DRAW_MAX_PIXELS)
}

export type CanvasProvenCrop = CanvasProvenCropPixels & { mimeType: 'image/png' }

export type CanvasProvenCropObjectUrlApi = {
  create: (blob: Blob) => string
  revoke: (url: string) => void
}

export type CanvasProvenCropRegistryLimits = {
  maxEntries: number
  maxBytes: number
  maxEntryBytes: number
}

export type CanvasProvenCropRegistry = {
  /**
   * Keeps the PNG drawn for an item's proven crop. The caller must have drawn
   * it from verified bytes; the registry only checks that the item still has a
   * verifiable crop and that the PNG has the crop's pixel size. Replaces an
   * older entry of the same item. Null when refused.
   */
  register: (
    item: CanvasImageItem,
    png: Blob,
    size: { width: number; height: number }
  ) => CanvasProvenCrop | null
  /** The entry made for exactly this item id, source, record and crop, or null. */
  lookup: (item: CanvasImageItem) => CanvasProvenCrop | null
  /** Whether lookup would find an entry; does not change the recency order. */
  has: (item: CanvasImageItem) => boolean
  /** Whether a PNG of this many bytes fits without evicting another entry. */
  canAddWithoutEviction: (bytes: number) => boolean
  /**
   * Marks a proof of this item's crop as running (a confirm read or a fill),
   * so a second reader does not read and draw the same source. Returns the
   * function that clears the mark.
   */
  beginPending: (itemId: string) => () => void
  isPending: (itemId: string) => boolean
  /** Revokes every object URL and forgets every entry; the registry stays usable. */
  release: () => void
  /**
   * Calls listener with the item id after each entry is made, so a view that
   * waits for a crop's pixels (a selection drag snapshot) can prepare again.
   * Returns the unsubscribe function.
   */
  subscribe: (listener: (itemId: string) => void) => () => void
  readonly entryCount: number
  readonly totalBytes: number
}

type RegistryEntry = CanvasProvenCrop & { key: string; itemId: string; blob: Blob }

const defaultObjectUrlApi: CanvasProvenCropObjectUrlApi = {
  create: (blob) => URL.createObjectURL(blob),
  revoke: (url) => URL.revokeObjectURL(url)
}

/** The identity of a proven crop: item id, source, record and the crop itself. */
export function getCanvasProvenCropKey(item: CanvasImageItem): string | null {
  if (item?.type !== 'image' || !item.crop || !hasVerifiableCrop(item)) return null
  const record = item.cropSource!
  const { x, y, width, height } = item.crop
  return JSON.stringify([
    item.id,
    item.src,
    record.sha256,
    record.sizeBytes,
    record.width,
    record.height,
    x,
    y,
    width,
    height
  ])
}

/** The pixel size the crop is drawn at: the crop normalized against its record. */
export function getCanvasProvenCropOutputSize(
  item: CanvasImageItem
): { width: number; height: number } | null {
  if (!getCanvasProvenCropKey(item)) return null
  const record = item.cropSource!
  const crop = normalizeCanvasImageDisplayCrop(item.crop, record.width, record.height)
  if (!crop) return null
  return {
    width: Math.max(1, Math.round(crop.width)),
    height: Math.max(1, Math.round(crop.height))
  }
}

export function createCanvasProvenCropRegistry(
  limits: Partial<CanvasProvenCropRegistryLimits> = {},
  objectUrlApi: CanvasProvenCropObjectUrlApi = defaultObjectUrlApi
): CanvasProvenCropRegistry {
  const maxEntries = limits.maxEntries ?? CANVAS_PROVEN_CROP_REGISTRY_MAX_ENTRIES
  const maxBytes = limits.maxBytes ?? CANVAS_PROVEN_CROP_REGISTRY_MAX_BYTES
  const maxEntryBytes = Math.min(
    limits.maxEntryBytes ?? CANVAS_PROVEN_CROP_ENTRY_MAX_BYTES,
    maxBytes
  )
  // Map order is the recency order: the first entry is the least recently used.
  const entries = new Map<string, RegistryEntry>()
  const listeners = new Set<(itemId: string) => void>()
  const pendingCounts = new Map<string, number>()
  let totalBytes = 0

  const revoke = (entry: RegistryEntry) => {
    try {
      objectUrlApi.revoke(entry.url)
    } catch {
      // A failed revoke leaves nothing else to release.
    }
  }

  const remove = (itemId: string) => {
    const entry = entries.get(itemId)
    if (!entry) return
    entries.delete(itemId)
    totalBytes -= entry.blob.size
    revoke(entry)
  }

  const toPublic = (entry: RegistryEntry): CanvasProvenCrop => ({
    url: entry.url,
    fileName: entry.fileName,
    mimeType: entry.mimeType,
    sizeBytes: entry.sizeBytes,
    width: entry.width,
    height: entry.height
  })

  return {
    register(item, png, size) {
      const key = getCanvasProvenCropKey(item)
      const expected = key ? getCanvasProvenCropOutputSize(item) : null
      if (!key || !expected) return null
      if (
        typeof Blob === 'undefined' ||
        !(png instanceof Blob) ||
        png.type !== 'image/png' ||
        png.size <= 0 ||
        png.size > maxEntryBytes ||
        size?.width !== expected.width ||
        size?.height !== expected.height
      ) {
        return null
      }
      let url: string
      try {
        url = objectUrlApi.create(png)
      } catch {
        return null
      }
      if (typeof url !== 'string' || !url.startsWith('blob:')) {
        try {
          if (typeof url === 'string') objectUrlApi.revoke(url)
        } catch {
          // Nothing else to release.
        }
        return null
      }
      remove(item.id)
      const entry: RegistryEntry = {
        key,
        itemId: item.id,
        blob: png,
        url,
        fileName: getCanvasImageCropPngFileName(item),
        mimeType: 'image/png',
        sizeBytes: png.size,
        width: expected.width,
        height: expected.height
      }
      entries.set(item.id, entry)
      totalBytes += png.size
      for (const oldest of entries.values()) {
        if (entries.size <= maxEntries && totalBytes <= maxBytes) break
        if (oldest === entry) break
        remove(oldest.itemId)
      }
      for (const listener of Array.from(listeners)) {
        try {
          listener(item.id)
        } catch {
          // A listener's failure does not undo the entry.
        }
      }
      return toPublic(entry)
    },
    lookup(item) {
      const key = getCanvasProvenCropKey(item)
      if (!key) return null
      const entry = entries.get(item.id)
      if (!entry || entry.key !== key) return null
      entries.delete(item.id)
      entries.set(item.id, entry)
      return toPublic(entry)
    },
    has(item) {
      const key = getCanvasProvenCropKey(item)
      return Boolean(key && entries.get(item.id)?.key === key)
    },
    canAddWithoutEviction(bytes) {
      return (
        Number.isFinite(bytes) &&
        bytes > 0 &&
        bytes <= maxEntryBytes &&
        entries.size + 1 <= maxEntries &&
        totalBytes + bytes <= maxBytes
      )
    },
    beginPending(itemId) {
      pendingCounts.set(itemId, (pendingCounts.get(itemId) ?? 0) + 1)
      let done = false
      return () => {
        if (done) return
        done = true
        const count = (pendingCounts.get(itemId) ?? 1) - 1
        if (count > 0) pendingCounts.set(itemId, count)
        else pendingCounts.delete(itemId)
      }
    },
    isPending(itemId) {
      return pendingCounts.has(itemId)
    },
    release() {
      const all = Array.from(entries.values())
      entries.clear()
      totalBytes = 0
      for (const entry of all) revoke(entry)
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    get entryCount() {
      return entries.size
    },
    get totalBytes() {
      return totalBytes
    }
  }
}

/**
 * After an Agent send proved its crops (prepareCanvasAgentCropDelivery
 * 'ready'), keeps the drawn PNG of each proven crop so a later drag of the same
 * crop can use it. originals and attachmentItems are the selection before and
 * after preparation, in the same order. Best effort: a refused or failed entry
 * changes nothing about the send. Returns the number of entries made.
 */
export function registerCanvasAgentSendProvenCrops(
  registry: CanvasProvenCropRegistry | null | undefined,
  originals: CanvasItem[],
  attachmentItems: CanvasItem[]
): number {
  if (!registry || originals.length !== attachmentItems.length) return 0
  let registered = 0
  originals.forEach((original, index) => {
    const prepared = attachmentItems[index]
    if (
      original.type !== 'image' ||
      !original.crop ||
      prepared?.type !== 'image' ||
      prepared.id !== original.id ||
      prepared.crop ||
      prepared.src === original.src ||
      !getCanvasProvenCropKey(original)
    ) {
      return
    }
    // Skip the decode of a PNG the registry would refuse for its size.
    if ((prepared.sizeBytes ?? 0) > CANVAS_PROVEN_CROP_ENTRY_MAX_BYTES) return
    try {
      const png = canvasPngDataUrlToBlob(prepared.src)
      if (!png) return
      const entry = registry.register(original, png, {
        width: prepared.sourceWidth ?? 0,
        height: prepared.sourceHeight ?? 0
      })
      if (entry) registered += 1
    } catch {
      // The send does not depend on the drag registry.
    }
  })
  return registered
}
