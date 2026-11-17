// packages/app/src/renderer/src/pages/ProjectCanvasPage/canvasProvenCropRegistry.ts
// The drawn pixels of proven crops, for sinks that cannot read and hash a
// source themselves (a drag start is synchronous). An entry is made only from
// bytes whose size, SHA-256 and decoded size matched the item's record: the
// background record after a crop confirm, or a successful Agent send. It is
// found again only for the same item id, source, record and crop. Only the
// cropped pixels are held, as small PNG Blobs behind canvas-owned object URLs;
// the registry is bounded and released with the board.
import {
  getCanvasImageCropPngFileName,
  type CanvasProvenCropPixels
} from './canvasAgentAttachmentUtils'
import { hasVerifiableCrop } from './canvasCropProvenance'
import { normalizeCanvasImageDisplayCrop } from './canvasImageDisplayUtils'
import type { CanvasImageItem } from './types'

export const CANVAS_PROVEN_CROP_REGISTRY_MAX_ENTRIES = 24
export const CANVAS_PROVEN_CROP_REGISTRY_MAX_BYTES = 64 * 1024 * 1024
export const CANVAS_PROVEN_CROP_ENTRY_MAX_BYTES = 32 * 1024 * 1024

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
  /** Revokes every object URL and forgets every entry; the registry stays usable. */
  release: () => void
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
    release() {
      const all = Array.from(entries.values())
      entries.clear()
      totalBytes = 0
      for (const entry of all) revoke(entry)
    },
    get entryCount() {
      return entries.size
    },
    get totalBytes() {
      return totalBytes
    }
  }
}
