// packages/app/src/renderer/src/pages/ProjectCanvasPage/useCanvasLegacyCropUpgrade.ts
// Owner decision 2: a crop saved before crop source records existed is
// re-measured once when its board is opened. When the source still has exactly
// the stored pixel size (and, where one was stored, the stored byte size) and
// the crop lies inside it, the crop gets a record with origin 'reopen'.
//
// A 'reopen' record only lets the Agent send what the canvas shows right now
// (the crop drawn in the sourceWidth x sourceHeight space, verified again at
// send time). Matching pixel size does not certify how the crop was measured,
// so it never enables the mirror flatten or the identity strip: those require
// origin 'confirm' (isConfirmedIdentityCrop).
import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import {
  CANVAS_CROP_SOURCE_EVIDENCE_MAX_BYTES,
  createCropSourceRecord,
  hasVerifiableCrop,
  readCanvasImageSourceEvidence,
  type CanvasImageSourceEvidence
} from './canvasCropProvenance'
import type { CanvasItemsLoadedEvent } from './useCanvasViewportPersistence'
import type { CanvasImageCropSource, CanvasImageItem, CanvasItem } from './types'

type CanvasCrop = NonNullable<CanvasImageItem['crop']>

export type CanvasLegacyCropEvidence = Pick<
  CanvasImageSourceEvidence,
  'sizeBytes' | 'sha256' | 'width' | 'height'
>

/** Reads the source once (authorized path, byte cap); null on any failure or when stale. */
export type CanvasLegacyCropEvidenceReader = (
  src: string,
  isCurrent: () => boolean
) => Promise<CanvasLegacyCropEvidence | null>

export type CanvasLegacyCropRefusal =
  | 'no-source-size'
  | 'crop-outside-source'
  | 'source-too-large'
  | 'source-unavailable'
  | 'pixel-size-mismatch'
  | 'byte-size-mismatch'

export type CanvasLegacyCropCandidate = {
  id: string
  crop: CanvasCrop
  sourceWidth: number
  sourceHeight: number
  /** The byte size stored with the item, when one was: it must match too. */
  expectedSizeBytes: number | null
}

const readLegacyCropEvidence: CanvasLegacyCropEvidenceReader = (src, isCurrent) =>
  readCanvasImageSourceEvidence(src, isCurrent, {
    maxBytes: CANVAS_CROP_SOURCE_EVIDENCE_MAX_BYTES
  })

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function isCropInsideSource(crop: CanvasCrop, width: number, height: number): boolean {
  const { x, y, width: cropWidth, height: cropHeight } = crop
  if (![x, y, cropWidth, cropHeight].every((value) => Number.isFinite(value))) return false
  return (
    x >= 0 &&
    y >= 0 &&
    cropWidth > 0 &&
    cropHeight > 0 &&
    x + cropWidth <= width &&
    y + cropHeight <= height
  )
}

function getStoredSourceSizeBytes(item: CanvasImageItem): number | null {
  const identity = item.sourceIdentity
  if (identity?.kind === 'local-file' && isPositiveSafeInteger(identity.sizeBytes)) {
    return identity.sizeBytes
  }
  return isPositiveSafeInteger(item.sizeBytes) ? item.sizeBytes : null
}

function isSameCrop(left: CanvasCrop | undefined, right: CanvasCrop): boolean {
  return Boolean(
    left &&
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
  )
}

/**
 * Cropped images without a record, judged on the items as they were stored
 * (before hydration can backfill size hints). Without a stored pixel size there
 * is nothing to compare with, and a crop outside the stored size is refused.
 */
export function collectCanvasLegacyCropCandidates(storedItems: readonly CanvasItem[]): {
  candidates: CanvasLegacyCropCandidate[]
  refusals: CanvasLegacyCropRefusal[]
} {
  const candidates: CanvasLegacyCropCandidate[] = []
  const refusals: CanvasLegacyCropRefusal[] = []
  for (const item of storedItems) {
    if (item.type !== 'image' || !item.crop || item.cropSource !== undefined) continue
    const { sourceWidth, sourceHeight } = item
    if (!isPositiveSafeInteger(sourceWidth) || !isPositiveSafeInteger(sourceHeight)) {
      refusals.push('no-source-size')
      continue
    }
    if (!isCropInsideSource(item.crop, sourceWidth, sourceHeight)) {
      refusals.push('crop-outside-source')
      continue
    }
    candidates.push({
      id: item.id,
      crop: { x: item.crop.x, y: item.crop.y, width: item.crop.width, height: item.crop.height },
      sourceWidth,
      sourceHeight,
      expectedSizeBytes: getStoredSourceSizeBytes(item)
    })
  }
  return { candidates, refusals }
}

/** The live item still shows the stored crop in the stored space and has no record. */
function isUnchangedCandidate(
  item: CanvasItem | undefined,
  candidate: CanvasLegacyCropCandidate,
  src?: string
): item is CanvasImageItem {
  return Boolean(
    item &&
    item.type === 'image' &&
    typeof item.src === 'string' &&
    item.src.length > 0 &&
    (src === undefined || item.src === src) &&
    item.cropSource === undefined &&
    item.sourceWidth === candidate.sourceWidth &&
    item.sourceHeight === candidate.sourceHeight &&
    isSameCrop(item.crop, candidate.crop)
  )
}

/** Byte size and pixel size of the evidence equal what was stored with the item. */
export function resolveCanvasLegacyCropEvidence(
  candidate: CanvasLegacyCropCandidate,
  evidence: CanvasLegacyCropEvidence
): { record: CanvasImageCropSource } | { refusal: CanvasLegacyCropRefusal } {
  if (evidence.width !== candidate.sourceWidth || evidence.height !== candidate.sourceHeight) {
    return { refusal: 'pixel-size-mismatch' }
  }
  if (candidate.expectedSizeBytes !== null && evidence.sizeBytes !== candidate.expectedSizeBytes) {
    return { refusal: 'byte-size-mismatch' }
  }
  const record = createCropSourceRecord(evidence, 'reopen')
  return record ? { record } : { refusal: 'source-unavailable' }
}

function logLegacyCropRefusal(reason: CanvasLegacyCropRefusal): void {
  // One line, never the path: these are files the user did not ask to send.
  console.warn(`[Canvas] A crop saved without a source record stays unverified (${reason}).`)
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

type UseCanvasLegacyCropUpgradeOptions = {
  canvasId: string
  items: CanvasItem[]
  /** Writes outside the undo history; the next save persists the record. */
  setItemsWithoutHistory: Dispatch<SetStateAction<CanvasItem[]>>
  readEvidence?: CanvasLegacyCropEvidenceReader
  waitForIdle?: () => Promise<void>
}

/**
 * Returns the handler for 'items loaded'. Each call starts one sequential pass
 * (superseding a running one), off the first paint, fenced by the canvas id,
 * unmount and each item's src, crop and size hints. All records of a pass are
 * written in one update, so the board turns dirty once.
 */
export function useCanvasLegacyCropUpgrade({
  canvasId,
  items,
  setItemsWithoutHistory,
  readEvidence = readLegacyCropEvidence,
  waitForIdle = waitForCanvasIdle
}: UseCanvasLegacyCropUpgradeOptions): {
  handleCanvasItemsLoaded: (event: CanvasItemsLoadedEvent) => void
} {
  const canvasIdRef = useRef(canvasId)
  canvasIdRef.current = canvasId
  const latestItemsRef = useRef(items)
  latestItemsRef.current = items
  const mountedRef = useRef(true)
  const passTokenRef = useRef(0)
  const optionsRef = useRef({ setItemsWithoutHistory, readEvidence, waitForIdle })
  optionsRef.current = { setItemsWithoutHistory, readEvidence, waitForIdle }

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      passTokenRef.current += 1
    }
  }, [])

  const runPass = useCallback(async (passCanvasId: string, storedItems: readonly CanvasItem[]) => {
    const token = ++passTokenRef.current
    const isPassCurrent = () =>
      mountedRef.current && passTokenRef.current === token && canvasIdRef.current === passCanvasId
    const { candidates, refusals } = collectCanvasLegacyCropCandidates(storedItems)
    if (candidates.length === 0) {
      refusals.forEach(logLegacyCropRefusal)
      return
    }
    await optionsRef.current.waitForIdle()
    if (!isPassCurrent()) return
    refusals.forEach(logLegacyCropRefusal)

    const findLive = (id: string) => latestItemsRef.current.find((item) => item.id === id)
    const attested = new Map<
      string,
      { candidate: CanvasLegacyCropCandidate; src: string; record: CanvasImageCropSource }
    >()
    for (const candidate of candidates) {
      if (!isPassCurrent()) return
      const live = findLive(candidate.id)
      // Changed or recorded since load: nothing to re-measure.
      if (!isUnchangedCandidate(live, candidate)) continue
      if (
        candidate.expectedSizeBytes !== null &&
        candidate.expectedSizeBytes > CANVAS_CROP_SOURCE_EVIDENCE_MAX_BYTES
      ) {
        logLegacyCropRefusal('source-too-large')
        continue
      }
      const src = live.src
      const isCurrent = () =>
        isPassCurrent() && isUnchangedCandidate(findLive(candidate.id), candidate, src)
      let evidence: CanvasLegacyCropEvidence | null
      try {
        evidence = await optionsRef.current.readEvidence(src, isCurrent)
      } catch {
        evidence = null
      }
      if (!isPassCurrent()) return
      if (!isCurrent()) continue
      if (!evidence) {
        logLegacyCropRefusal('source-unavailable')
        continue
      }
      const resolved = resolveCanvasLegacyCropEvidence(candidate, evidence)
      if ('refusal' in resolved) {
        logLegacyCropRefusal(resolved.refusal)
        continue
      }
      attested.set(candidate.id, { candidate, src, record: resolved.record })
    }
    if (attested.size === 0 || !isPassCurrent()) return

    optionsRef.current.setItemsWithoutHistory((prev) => {
      let changed = false
      const next = prev.map((item) => {
        const entry = attested.get(item.id)
        if (!entry || !isUnchangedCandidate(item, entry.candidate, entry.src)) return item
        const upgraded: CanvasImageItem = { ...item, cropSource: entry.record }
        if (!hasVerifiableCrop(upgraded)) return item
        changed = true
        return upgraded
      })
      return changed ? next : prev
    })
  }, [])

  // The loaded items reach the canvas state in the same commit as this
  // request, so the pass (an effect) always sees them as live items.
  const [passRequest, setPassRequest] = useState<CanvasItemsLoadedEvent | null>(null)
  useEffect(() => {
    if (!passRequest) return
    void runPass(passRequest.canvasId, passRequest.storedItems).catch(() => undefined)
  }, [passRequest, runPass])

  const handleCanvasItemsLoaded = useCallback((event: CanvasItemsLoadedEvent) => {
    if (event.canvasId !== canvasIdRef.current) return
    setPassRequest({ canvasId: event.canvasId, storedItems: event.storedItems })
  }, [])

  return { handleCanvasItemsLoaded }
}
