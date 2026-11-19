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
// Entries of deleted, uncropped or re-cropped items are dropped as soon as the
// items change. Selected crops come first (a drag starts from the selection) and
// may evict older entries. Other crops are drawn only while the registry has room, so the
// fill never churns the registry. A crop that fails to prove is not read again
// for the same key.
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

/** Keys that failed to prove are remembered up to this count. */
const FAILED_KEY_LIMIT = 512

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
      const candidates = current.items.filter(
        (item): item is CroppedImage =>
          isFillCandidate(item) &&
          !activeRegistry.has(item) &&
          !activeRegistry.isPending(item.id) &&
          !failedKeys.has(getCanvasProvenCropKey(item) ?? '')
      )
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
        const isSelected = latestRef.current.selectedIds.has(live.id)
        // Other crops never evict an entry: they wait until the registry has room.
        if (!isSelected && !activeRegistry.canAddWithoutEviction(1)) continue
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
            if (failedKeys.size >= FAILED_KEY_LIMIT) failedKeys.clear()
            failedKeys.add(key)
            continue
          }
          const png = await latestRef.current.drawCrop(live, evidence)
          if (!png || !isCurrent()) {
            if (!png) failedKeys.add(key)
            continue
          }
          const stillSelected = latestRef.current.selectedIds.has(live.id)
          if (!stillSelected && !activeRegistry.canAddWithoutEviction(png.blob.size)) continue
          activeRegistry.register(live, png.blob, png)
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
