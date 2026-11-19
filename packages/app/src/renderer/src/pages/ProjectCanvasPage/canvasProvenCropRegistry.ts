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
  /**
   * The registered PNG itself for exactly this item id, source, record and
   * crop, for a sink that copies the bytes (the Agent send) instead of
   * borrowing the object URL. Null when there is none.
   */
  lookupPng: (item: CanvasImageItem) => CanvasProvenCropPng | null
  /**
   * Drops the entries of items that are gone or now show another proven crop
   * (or no crop). An item whose crop has no record yet keeps its entry: the
   * record may still be landing. Returns the number of entries dropped.
   */
  prune: (liveItems: readonly CanvasItem[]) => number
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

export type CanvasProvenCropPng = {
  blob: Blob
  fileName: string
  width: number
  height: number
}

type RegistryEntry = CanvasProvenCrop & {
  key: string
  itemId: string
  blob: Blob
  /** PNG bytes plus the key's UTF-16 bytes: what the entry keeps alive. */
  retainedBytes: number
}

const defaultObjectUrlApi: CanvasProvenCropObjectUrlApi = {
  create: (blob) => URL.createObjectURL(blob),
  revoke: (url) => URL.revokeObjectURL(url)
}

/** Sources up to this length are part of a key verbatim; longer ones by fingerprint. */
const SOURCE_KEY_MAX_LENGTH = 2048
const KEY_BYTES_ALLOWANCE = 8 * 1024
const SOURCE_FINGERPRINT_WINDOWS = 256
const SOURCE_FINGERPRINT_WINDOW_LENGTH = 16

/**
 * A short stand-in for a long source (a data: URL can be tens of MiB): its
 * length and an FNV-1a hash of its head, its tail and evenly spaced windows.
 * The key never holds a copy of such a source, and a lookup never walks it
 * whole. The record's byte size and SHA-256 in the same key bind the bytes.
 */
function getCanvasProvenCropSourceKey(src: string): string {
  if (typeof src !== 'string') return ''
  if (src.length <= SOURCE_KEY_MAX_LENGTH) return src
  let hash = 0x811c9dc5
  const mix = (start: number) => {
    const end = Math.min(src.length, start + SOURCE_FINGERPRINT_WINDOW_LENGTH)
    for (let index = start; index < end; index += 1) {
      hash ^= src.charCodeAt(index)
      hash = Math.imul(hash, 0x01000193) >>> 0
    }
  }
  const step = Math.floor(
    (src.length - SOURCE_FINGERPRINT_WINDOW_LENGTH) / (SOURCE_FINGERPRINT_WINDOWS - 1)
  )
  for (let window = 0; window < SOURCE_FINGERPRINT_WINDOWS - 1; window += 1) mix(window * step)
  mix(src.length - SOURCE_FINGERPRINT_WINDOW_LENGTH)
  return `#${src.length}:${hash.toString(16)}:${src.slice(0, 64)}`
}

/**
 * The identity of a proven crop: item id, source (verbatim when short, else a
 * fingerprint), record and the crop itself. At most a few KiB long.
 */
export function getCanvasProvenCropKey(item: CanvasImageItem): string | null {
  if (item?.type !== 'image' || !item.crop || !hasVerifiableCrop(item)) return null
  const record = item.cropSource!
  const { x, y, width, height } = item.crop
  return JSON.stringify([
    item.id,
    getCanvasProvenCropSourceKey(item.src),
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
    totalBytes -= entry.retainedBytes
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
        height: expected.height,
        retainedBytes: png.size + key.length * 2
      }
      entries.set(item.id, entry)
      totalBytes += entry.retainedBytes
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
    lookupPng(item) {
      const key = getCanvasProvenCropKey(item)
      if (!key) return null
      const entry = entries.get(item.id)
      if (!entry || entry.key !== key) return null
      entries.delete(item.id)
      entries.set(item.id, entry)
      return {
        blob: entry.blob,
        fileName: entry.fileName,
        width: entry.width,
        height: entry.height
      }
    },
    prune(liveItems) {
      if (entries.size === 0) return 0
      const liveById = new Map<string, CanvasItem>()
      for (const item of liveItems) {
        if (entries.has(item.id)) liveById.set(item.id, item)
      }
      let dropped = 0
      for (const entry of Array.from(entries.values())) {
        const live = liveById.get(entry.itemId)
        let keep = false
        if (live?.type === 'image' && live.crop) {
          const liveKey = getCanvasProvenCropKey(live)
          keep = liveKey === null || liveKey === entry.key
        }
        if (!keep) {
          remove(entry.itemId)
          dropped += 1
        }
      }
      return dropped
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
        // The entry's key is counted too: at most a few KiB.
        totalBytes + bytes + KEY_BYTES_ALLOWANCE <= maxBytes
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
      !getCanvasProvenCropKey(original) ||
      // Sent from its registered PNG: nothing new to keep, no base64 decode.
      registry.has(original)
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
