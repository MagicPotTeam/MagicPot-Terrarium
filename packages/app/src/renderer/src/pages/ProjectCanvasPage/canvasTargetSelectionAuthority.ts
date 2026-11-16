import type { CanvasTargetEvidenceMode } from '@shared/canvasTarget'

import { normalizeCanvasTargetEvidenceMode } from './canvasTargetEvidence'
import { sanitizeCanvasItemForCheckContext } from './canvasTargetWorkflowAssetMetadata'
import type { CanvasItem } from './types'

// The one place that decides which canvas items a Canvas Target run may let
// the model, a QuickApp runtime or a tool result see. The authority is the
// set of items the user selected when the target dialog was opened, together
// with a signature of each item as it was presented then. Every check refuses
// by default: no authority, an unknown or missing id, a changed item or an
// evidence mode that does not allow source reads all deny.

export type CanvasTargetSelectionAuthority = Readonly<{
  itemIds: readonly string[]
  itemSignatures: ReadonlyMap<string, string>
  selectionSignature: string
}>

export type CanvasTargetSourceReferenceRefusal =
  'no_authority' | 'evidence_mode' | 'unresolved' | 'not_selected' | 'missing' | 'changed'

export type CanvasTargetSourceReferenceVerdict =
  | { allowed: true; items: CanvasItem[] }
  | { allowed: false; refusal: CanvasTargetSourceReferenceRefusal; references: string[] }

// Serializable scene content of the items as presented. This detects later
// edits (including undo / redo and a replaced src); it does not authenticate
// bytes behind a mutable URL or prove pixel provenance.
export function canvasTargetSelectionSignature(items: readonly CanvasItem[]): string {
  return JSON.stringify(
    [...items]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((item) => sanitizeCanvasItemForCheckContext(item))
  )
}

export function canvasTargetItemSourceSignature(item: CanvasItem): string {
  return canvasTargetSelectionSignature([item])
}

export function createCanvasTargetSelectionAuthority(
  items: readonly CanvasItem[]
): CanvasTargetSelectionAuthority | null {
  if (items.length === 0) return null
  const itemSignatures = new Map<string, string>()
  for (const item of items) {
    // Two entries with the same id cannot both be the item the user saw.
    if (itemSignatures.has(item.id)) return null
    itemSignatures.set(item.id, canvasTargetItemSourceSignature(item))
  }
  return Object.freeze({
    itemIds: Object.freeze(items.map((item) => item.id)),
    itemSignatures,
    selectionSignature: canvasTargetSelectionSignature(items)
  })
}

// True only when every selected item still exists exactly once and is
// unchanged since the authority was taken.
export function isCanvasTargetSelectionUnchanged(
  authority: CanvasTargetSelectionAuthority | null | undefined,
  currentItems: readonly CanvasItem[]
): boolean {
  if (!authority) return false
  const expectedIds = new Set(authority.itemIds)
  const currentSelected = currentItems.filter((item) => expectedIds.has(item.id))
  return (
    expectedIds.size === authority.itemIds.length &&
    currentSelected.length === expectedIds.size &&
    canvasTargetSelectionSignature(currentSelected) === authority.selectionSignature
  )
}

// Only the explicit full-source mode lets a run read the original bytes of a
// selected item (source attachments, model-planned extraction, item-backed
// QuickApp inputs). The restricted modes never read a source by reference.
export function canvasTargetEvidenceAllowsSourceReads(mode: CanvasTargetEvidenceMode): boolean {
  return normalizeCanvasTargetEvidenceMode(mode) === 'selected_sources'
}

// structured_only renders no screenshot at all.
export function canvasTargetEvidenceAllowsSelectionSnapshot(
  mode: CanvasTargetEvidenceMode
): boolean {
  return normalizeCanvasTargetEvidenceMode(mode) !== 'structured_only'
}

// A selection_region snapshot clips by canvas bounds. A legacy crop has no
// recorded source size and hash, so its coordinates cannot be verified
// against the source and the run is refused before anything is rendered.
export function canvasTargetSelectionHasUnverifiedCrop(
  mode: CanvasTargetEvidenceMode,
  items: readonly CanvasItem[]
): boolean {
  return (
    normalizeCanvasTargetEvidenceMode(mode) === 'selection_region' &&
    items.some((item) => item.type === 'image' && Boolean(item.crop))
  )
}

// Decide whether a model plan may read the sources it references. All
// references are checked before any is honoured, so a mixed reference is
// refused as a whole.
export function authorizeCanvasTargetSourceReferences(options: {
  authority: CanvasTargetSelectionAuthority | null | undefined
  evidenceMode: CanvasTargetEvidenceMode
  referencedItemIds: readonly string[]
  unresolvedReferences?: readonly string[]
  currentItems: readonly CanvasItem[]
}): CanvasTargetSourceReferenceVerdict {
  const referencedItemIds = Array.from(new Set(options.referencedItemIds))
  if (!options.authority) {
    return { allowed: false, refusal: 'no_authority', references: referencedItemIds }
  }
  if (!canvasTargetEvidenceAllowsSourceReads(options.evidenceMode)) {
    return { allowed: false, refusal: 'evidence_mode', references: referencedItemIds }
  }
  const unresolved = Array.from(new Set(options.unresolvedReferences || []))
  if (unresolved.length > 0) {
    return { allowed: false, refusal: 'unresolved', references: unresolved }
  }

  const notSelected = referencedItemIds.filter((id) => !options.authority!.itemSignatures.has(id))
  if (notSelected.length > 0) {
    return { allowed: false, refusal: 'not_selected', references: notSelected }
  }

  const currentById = new Map<string, CanvasItem[]>()
  for (const item of options.currentItems) {
    const entries = currentById.get(item.id)
    if (entries) entries.push(item)
    else currentById.set(item.id, [item])
  }
  const missing = referencedItemIds.filter((id) => currentById.get(id)?.length !== 1)
  if (missing.length > 0) {
    return { allowed: false, refusal: 'missing', references: missing }
  }

  const items = referencedItemIds.map((id) => currentById.get(id)![0])
  const changed = items
    .filter(
      (item) =>
        canvasTargetItemSourceSignature(item) !== options.authority!.itemSignatures.get(item.id)
    )
    .map((item) => item.id)
  if (changed.length > 0) {
    return { allowed: false, refusal: 'changed', references: changed }
  }

  return { allowed: true, items }
}

function canvasItemReferencesUrl(value: unknown, url: string, depth: number): boolean {
  if (typeof value === 'string') return value.trim() === url
  if (depth <= 0 || !value || typeof value !== 'object') return false
  if (Array.isArray(value))
    return value.some((entry) => canvasItemReferencesUrl(entry, url, depth - 1))
  // Only plain data (src, textures, preview images, thumbnail levels); decoded
  // images, blobs and other runtime objects are not URL carriers here.
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  return Object.values(value).some((entry) => canvasItemReferencesUrl(entry, url, depth - 1))
}

// A model-authored media URL that equals any URL a canvas item carries (its
// src, a texture, a preview image, a thumbnail) is a reference to that item,
// whatever action carries it.
export function findCanvasTargetItemIdsBySourceUrl(
  url: string,
  items: readonly CanvasItem[]
): string[] {
  const normalized = url.trim()
  if (!normalized) return []
  return items.filter((item) => canvasItemReferencesUrl(item, normalized, 5)).map((item) => item.id)
}
