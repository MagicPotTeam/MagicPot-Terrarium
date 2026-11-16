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
      .map((item) => [sanitizeCanvasItemForCheckContext(item), canvasItemSecondarySourceUrls(item)])
  )
}

// The prompt-safe projection above records only texture names and preview
// image ids. A replaced texture or preview image is a changed source too, so
// the signature also carries those URLs. Thumbnails are left out: they are
// derived from src and may be generated after the item was selected.
function canvasItemSecondarySourceUrls(item: CanvasItem): string[] {
  if (item.type === 'model3d') {
    return Object.entries(item.textures || {})
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([name, url]) => `${name}=${String(url)}`)
  }
  if (item.type === 'file') {
    return (item.previewImages || []).map((image) => String(image.src))
  }
  return []
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

// Drops every C0 control character, space and DEL.
function stripControlsAndSpaces(value: string): string {
  let out = ''
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code > 0x20 && code !== 0x7f) out += value[index]
  }
  return out
}

function urlSchemeOf(value: string): string | null {
  // Only the head is inspected, so multi-MB data: URLs are never copied.
  const head = stripControlsAndSpaces(value.slice(0, 64)).toLowerCase()
  const match = /^([a-z][a-z0-9+.-]*):/.exec(head)
  return match ? match[1] : null
}

// The identity a URL resolves to, for comparison only: parsed as the browser
// would (leading / trailing C0 and space stripped, tab and newline removed,
// scheme lower-cased), the fragment dropped (a blob: URL resolves to the same
// blob whatever its fragment) and percent-escapes decoded. For blob: URLs the
// whole key is lower-cased and every C0 control and space removed, so case
// or control-character variants of one blob URL share one key. Returns null
// for a value that does not parse.
export function canvasTargetMediaUrlKey(value: string): string | null {
  if (typeof value !== 'string') return null
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return null
  }
  parsed.hash = ''
  const href = parsed.href.endsWith('#') ? parsed.href.slice(0, -1) : parsed.href
  if (parsed.protocol !== 'blob:') return href
  let decoded: string
  try {
    decoded = decodeURIComponent(href)
  } catch {
    return null
  }
  return stripControlsAndSpaces(decoded).toLowerCase()
}

// Calls visit for every string an item carries in plain data (src, textures,
// preview images, thumbnail levels). Decoded images, blobs and other runtime
// objects are not URL carriers here.
function visitCanvasItemStrings(
  value: unknown,
  depth: number,
  visit: (entry: string) => boolean
): boolean {
  if (typeof value === 'string') return visit(value)
  if (depth <= 0 || !value || typeof value !== 'object') return false
  if (Array.isArray(value)) {
    return value.some((entry) => visitCanvasItemStrings(entry, depth - 1, visit))
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  return Object.values(value).some((entry) => visitCanvasItemStrings(entry, depth - 1, visit))
}

const CANVAS_ITEM_URL_DEPTH = 5

function findCanvasItemUrlMatch(item: CanvasItem, scheme: string, key: string): string | null {
  let match: string | null = null
  visitCanvasItemStrings(item, CANVAS_ITEM_URL_DEPTH, (entry) => {
    if (urlSchemeOf(entry) !== scheme || canvasTargetMediaUrlKey(entry) !== key) return false
    match = entry
    return true
  })
  return match
}

function findCanvasTargetItemUrlMatches(
  url: string,
  items: readonly CanvasItem[]
): Array<{ id: string; url: string }> {
  const key = canvasTargetMediaUrlKey(url)
  const scheme = urlSchemeOf(url)
  if (!key || !scheme) return []
  const matches: Array<{ id: string; url: string }> = []
  for (const item of items) {
    const match = findCanvasItemUrlMatch(item, scheme, key)
    if (match !== null) matches.push({ id: item.id, url: match })
  }
  return matches
}

// A model-authored media URL that resolves to any URL a canvas item carries
// (its src, a texture, a preview image, a thumbnail) is a reference to that
// item, whatever action carries it.
export function findCanvasTargetItemIdsBySourceUrl(
  url: string,
  items: readonly CanvasItem[]
): string[] {
  return findCanvasTargetItemUrlMatches(url, items).map((match) => match.id)
}

// Adds the key of every blob: URL the items carry. A run keeps this set from
// its start and adds to it before each canvas action, so an item that the
// run deletes (or replaces) stays known as a canvas source.
export function collectCanvasTargetCanvasBlobUrlKeys(
  items: readonly CanvasItem[],
  into: Set<string>
): Set<string> {
  for (const item of items) {
    visitCanvasItemStrings(item, CANVAS_ITEM_URL_DEPTH, (entry) => {
      if (urlSchemeOf(entry) !== 'blob') return false
      const key = canvasTargetMediaUrlKey(entry)
      if (key) into.add(key)
      return false
    })
  }
  return into
}

// Records a media URL this run produced (an extraction, a model, QuickApp or
// canvas stage output) under its key.
export function recordCanvasTargetRunOutputUrl(url: string | undefined, into: Map<string, string>) {
  if (!url || urlSchemeOf(url) !== 'blob') return
  const key = canvasTargetMediaUrlKey(url)
  if (key && !into.has(key)) into.set(key, url)
}

export type CanvasTargetMediaPlacementRefusal =
  CanvasTargetSourceReferenceRefusal | 'not_run_output'

export type CanvasTargetMediaPlacementVerdict =
  | { allowed: true; url: string }
  | { allowed: false; refusal: CanvasTargetMediaPlacementRefusal; references: string[] }

// Decide whether a model-authored add_image / add_video / add_model3d may
// place a URL. Only two kinds of URL may be placed, and the canonical URL is
// returned so that a variant spelling is never what reaches the canvas:
// - a URL of a selected item that is unchanged since selection, and only in
//   an evidence mode that may read sources;
// - a blob: URL this run produced itself that no canvas item carries or has
//   carried during the run.
// Anything else, including a URL that does not parse, a non-blob URL, and
// the URL of an item that is no longer on the canvas, is refused.
export function authorizeCanvasTargetMediaPlacementUrl(options: {
  url: string
  authority: CanvasTargetSelectionAuthority | null | undefined
  evidenceMode: CanvasTargetEvidenceMode
  currentItems: readonly CanvasItem[]
  knownCanvasUrlKeys: ReadonlySet<string>
  runOutputUrls: ReadonlyMap<string, string>
}): CanvasTargetMediaPlacementVerdict {
  const key = canvasTargetMediaUrlKey(options.url)
  if (!key || urlSchemeOf(options.url) !== 'blob' || !key.startsWith('blob:')) {
    return { allowed: false, refusal: 'not_run_output', references: [] }
  }

  const matches = findCanvasTargetItemUrlMatches(options.url, options.currentItems)
  if (matches.length > 0) {
    const verdict = authorizeCanvasTargetSourceReferences({
      authority: options.authority,
      evidenceMode: options.evidenceMode,
      referencedItemIds: matches.map((match) => match.id),
      currentItems: options.currentItems
    })
    if (!verdict.allowed) return verdict
    return { allowed: true, url: matches[0].url }
  }

  // Carried by a canvas item earlier in the run, but not by any item now:
  // the item was deleted or changed, so it cannot be authorized any more.
  if (options.knownCanvasUrlKeys.has(key)) {
    return { allowed: false, refusal: 'missing', references: [] }
  }

  const runOutputUrl = options.runOutputUrls.get(key)
  if (runOutputUrl) return { allowed: true, url: runOutputUrl }
  return { allowed: false, refusal: 'not_run_output', references: [] }
}
