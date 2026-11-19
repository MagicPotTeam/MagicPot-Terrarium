// packages/app/src/renderer/src/pages/ProjectCanvasPage/useCanvasProvenCropRegistryFill.ts
// Keeps proven crops draggable. A drag start is synchronous and can only carry
// a crop whose pixels the registry already holds. The registry starts empty on
// every board open and is bounded, so a crop whose stored record is valid can
// be missing from it: after a load, after an eviction, or after its entry was
// dropped with a deleted item that undo brought back. This hook draws those
// crops again, off the interaction path: at idle, one item at a time, with the
// same bounded read, hash and decode as a crop confirm, and only from bytes
// whose byte size, SHA-256 and pixel size equal the item's record.
//
// Entries of deleted, uncropped, re-cropped or re-sourced items are dropped as
// soon as the items change. Selected crops come first (a drag starts from the
// selection) and may evict the entries of unselected items, never those of
// other selected items. Other crops are drawn only while the registry has room.
//
// No crop is read again for nothing: a crop that fails to prove, whose PNG the
// registry refuses or whose PNG is over the per-entry cap is not read again for
// the same key (and the drag calls the last kind too large). The size of every
// drawn PNG is remembered, so a crop that did not fit, or whose entry was
// evicted, is read again only once the registry has room for that size (for a
// selected crop: next to the other selected crops' entries). Item and
// selection changes start no read while that room is missing.
import { useEffect, useRef } from 'react'
import { drawVerifiedCanvasImageCropPng } from './canvasAgentAttachmentUtils'
import {
  CANVAS_CROP_SOURCE_EVIDENCE_MAX_BYTES,
  hasVerifiableCrop,
  matchesCropSource,
  readCanvasImageSourceEvidence,
  type CanvasImageSourceEvidence
} from './canvasCropProvenance'
import {
  getCanvasProvenCropKey,
  isCanvasProvenCropDrawable,
  type CanvasProvenCropRegistry
} from './canvasProvenCropRegistry'
import type { CanvasImageItem, CanvasItem } from './types'

export type CanvasProvenCropFillEvidenceReader = (
  src: string,
  isCurrent: () => boolean
) => Promise<CanvasImageSourceEvidence | null>

export type CanvasProvenCropFillDrawer = typeof drawVerifiedCanvasImageCropPng

const readFillEvidence: CanvasProvenCropFillEvidenceReader = (src, isCurrent) =>
  readCanvasImageSourceEvidence(src, isCurrent, {
    maxBytes: CANVAS_CROP_SOURCE_EVIDENCE_MAX_BYTES
  })

/** Keys that failed to prove, and drawn PNG sizes, are remembered up to this count. */
const FAILED_KEY_LIMIT = 512

function rememberBounded<T>(map: Map<string, T>, key: string, value: T): void {
  map.delete(key)
  if (map.size >= FAILED_KEY_LIMIT) {
    const oldest = map.keys().next().value
    if (oldest !== undefined) map.delete(oldest)
  }
  map.set(key, value)
}

function waitForCanvasIdle(): Promise<void> {
  return new Promise((resolve) => {
    const requestIdle = (
      window as Window & {
        requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number
      }
    ).requestIdleCallback
    if (typeof requestIdle === 'function') {
      requestIdle.call(window, () => resolve(), { timeout: 2000 })
      return
    }
    window.setTimeout(resolve, 50)
  })
}

type CroppedImage = CanvasImageItem & { crop: NonNullable<CanvasImageItem['crop']> }

/** A selected crop may evict entries of unselected items only; any other crop none at all. */
function hasRoomForBytes(
  registry: CanvasProvenCropRegistry,
  bytes: number,
  isSelected: boolean,
  selectedIds: ReadonlySet<string>
): boolean {
  return isSelected
    ? registry.canAddKeeping(bytes, selectedIds)
    : registry.canAddWithoutEviction(bytes)
}

function isFillCandidate(item: CanvasItem): item is CroppedImage {
  return (
    item.type === 'image' &&
    Boolean(item.crop) &&
    item.cropSource !== undefined &&
    hasVerifiableCrop(item) &&
    item.cropSource.sizeBytes <= CANVAS_CROP_SOURCE_EVIDENCE_MAX_BYTES &&
    isCanvasProvenCropDrawable(item)
  )
}

type UseCanvasProvenCropRegistryFillOptions = {
  items: CanvasItem[]
  selectedIds: ReadonlySet<string>
  registry: CanvasProvenCropRegistry | null | undefined
  readEvidence?: CanvasProvenCropFillEvidenceReader
  drawCrop?: CanvasProvenCropFillDrawer
  waitForIdle?: () => Promise<void>
}

export function useCanvasProvenCropRegistryFill({
  items,
  selectedIds,
  registry,
  readEvidence = readFillEvidence,
  drawCrop = drawVerifiedCanvasImageCropPng,
  waitForIdle = waitForCanvasIdle
}: UseCanvasProvenCropRegistryFillOptions): void {
  const latestRef = useRef({ items, selectedIds, registry, readEvidence, drawCrop, waitForIdle })
  latestRef.current = { items, selectedIds, registry, readEvidence, drawCrop, waitForIdle }
  const mountedRef = useRef(true)
  const runningRef = useRef(false)
  const rerunRef = useRef(false)
  const failedKeysRef = useRef(new Set<string>())
  // Key -> byte size of the PNG last drawn for it: no read until that size fits.
  const drawnBytesRef = useRef(new Map<string, number>())

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  // Memory: an entry whose item was deleted, uncropped or re-cropped is dropped
  // at once (an undo brings it back through the fill below).
  useEffect(() => {
    if (registry && registry.entryCount > 0) registry.prune(items)
  }, [items, registry])

  useEffect(() => {
    // Nothing to do on boards without a proven crop: no idle callback at all.
    if (!registry || !items.some(isFillCandidate)) return
    if (runningRef.current) {
      rerunRef.current = true
      return
    }
    runningRef.current = true
    const findLive = (id: string) => latestRef.current.items.find((item) => item.id === id)

    const fillOnce = async (): Promise<void> => {
      const current = latestRef.current
      const activeRegistry = current.registry
      if (!activeRegistry) return
      const failedKeys = failedKeysRef.current
      const drawnBytes = drawnBytesRef.current
      const fail = (key: string) => {
        if (failedKeys.size >= FAILED_KEY_LIMIT) failedKeys.clear()
        failedKeys.add(key)
        drawnBytes.delete(key)
      }
      // Room for this crop's PNG, at its known size once it was drawn.
      const hasRoom = (key: string, isSelected: boolean) =>
        hasRoomForBytes(
          activeRegistry,
          drawnBytes.get(key) ?? 1,
          isSelected,
          latestRef.current.selectedIds
        )
      const candidates = current.items.filter((item): item is CroppedImage => {
        if (
          !isFillCandidate(item) ||
          activeRegistry.has(item) ||
          activeRegistry.isPending(item.id) ||
          activeRegistry.isTooLarge(item)
        ) {
          return false
        }
        const key = getCanvasProvenCropKey(item)
        return Boolean(
          key && !failedKeys.has(key) && hasRoom(key, current.selectedIds.has(item.id))
        )
      })
      // Selected crops first: a drag starts from the selection.
      const selected = current.selectedIds
      candidates.sort(
        (left, right) => Number(selected.has(right.id)) - Number(selected.has(left.id))
      )
      for (const candidate of candidates) {
        await latestRef.current.waitForIdle()
        if (!mountedRef.current || latestRef.current.registry !== activeRegistry) return
        const key = getCanvasProvenCropKey(candidate)
        const live = findLive(candidate.id)
        if (
          !key ||
          !live ||
          live.type !== 'image' ||
          getCanvasProvenCropKey(live) !== key ||
          activeRegistry.has(live) ||
          activeRegistry.isPending(live.id)
        ) {
          continue
        }
        if (failedKeys.has(key) || activeRegistry.isTooLarge(live)) continue
        if (!hasRoom(key, latestRef.current.selectedIds.has(live.id))) continue
        const isCurrent = () => {
          if (!mountedRef.current || latestRef.current.registry !== activeRegistry) return false
          const latest = findLive(live.id)
          return Boolean(
            latest && latest.type === 'image' && getCanvasProvenCropKey(latest) === key
          )
        }
        const endPending = activeRegistry.beginPending(live.id)
        try {
          let evidence: CanvasImageSourceEvidence | null
          try {
            evidence = await latestRef.current.readEvidence(live.src, isCurrent)
          } catch {
            evidence = null
          }
          if (!isCurrent()) continue
          if (!evidence || !matchesCropSource(live, evidence)) {
            fail(key)
            continue
          }
          const png = await latestRef.current.drawCrop(live, evidence)
          if (!png || !isCurrent()) {
            if (!png) fail(key)
            continue
          }
          if (png.blob.size > activeRegistry.maxEntryBytes) {
            // Never kept: the drag says the crop is too large.
            activeRegistry.markTooLarge(live)
            fail(key)
            continue
          }
          // Kept or not, its size decides whether it is read again (after an
          // eviction too): only once the registry has room for it.
          rememberBounded(drawnBytes, key, png.blob.size)
          const selectedIds = latestRef.current.selectedIds
          const stillSelected = selectedIds.has(live.id)
          if (!hasRoomForBytes(activeRegistry, png.blob.size, stillSelected, selectedIds)) continue
          const entry = activeRegistry.register(
            live,
            png.blob,
            png,
            stillSelected ? { keep: selectedIds } : undefined
          )
          if (!entry) fail(key)
        } finally {
          endPending()
        }
      }
    }

    const run = async () => {
      try {
        do {
          rerunRef.current = false
          await fillOnce()
        } while (rerunRef.current && mountedRef.current)
      } finally {
        runningRef.current = false
      }
    }
    void run().catch(() => undefined)
  }, [items, registry, selectedIds])
}
