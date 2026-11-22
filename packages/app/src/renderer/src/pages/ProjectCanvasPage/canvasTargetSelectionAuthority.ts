import type { CanvasTargetEvidenceMode } from '@shared/canvasTarget'

import {
  collectCascadeDeletedCanvasItemIds,
  isAttachedCaptionAnnotation
} from './canvasAttachedCaptionUtils'
import { resolveCanvasTargetGroupActionTargetGroups } from './canvasTargetCanvasActionGroups'
import { resolveCanvasTargetSemanticCanvasActionSourceIds } from './canvasTargetCanvasActionSources'
import type { CanvasTargetSemanticCanvasActionState } from './canvasTargetCanvasActionTypes'
import type { CanvasTargetCanvasAction } from './canvasTargetCapabilityTypes'
import { normalizeCanvasTargetEvidenceMode } from './canvasTargetEvidence'
import { sanitizeCanvasItemForCheckContext } from './canvasTargetWorkflowAssetMetadata'
import type { CanvasGroup, CanvasItem } from './types'

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

// Calls visit for EVERY string an item carries in plain data, up to a fixed
// depth: not only its media sources (src, textures, preview images,
// thumbnail levels) but also text, labels, captions, file metadata and any
// other string field. Decoded images, blobs and other runtime objects are not
// visited. Because it over-matches, it is used only where a match refuses
// more (which items a URL touches, which blob URLs the canvas knows), never
// to decide that a URL is an item's source; see canvasItemMediaSourceUrls.
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

// The fields that are an item's media source: what a placement of the item's
// URL would put on the canvas and hand back as a stage result. Image
// thumbnail levels are left out: they are derived from src, are not part of
// the selection signature and are never shown to the model as a source.
// Text, labels, captions, original-URL metadata and file fields are not
// sources, even when they hold a URL.
export function canvasItemMediaSourceUrls(item: CanvasItem): string[] {
  const urls: string[] = []
  const push = (value: unknown) => {
    if (typeof value === 'string' && value) urls.push(value)
  }
  switch (item.type) {
    case 'image':
    case 'video':
      push(item.src)
      break
    case 'model3d':
      push(item.src)
      for (const value of Object.values(item.textures || {})) push(value)
      break
    case 'file':
      push(item.src)
      for (const image of item.previewImages || []) push(image?.src)
      break
    default:
      break
  }
  return urls
}

function findCanvasItemMediaSourceMatch(
  item: CanvasItem,
  scheme: string,
  key: string
): string | null {
  for (const entry of canvasItemMediaSourceUrls(item)) {
    if (urlSchemeOf(entry) === scheme && canvasTargetMediaUrlKey(entry) === key) return entry
  }
  return null
}

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

// A model-authored media URL that resolves to any string a canvas item
// carries (its src, a texture, a preview image, a thumbnail, but also a text
// or label that holds the URL) is treated as a reference to that item,
// whatever action carries it. Over-matching here only refuses more.
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
// - the media source (canvasItemMediaSourceUrls) of a selected item that is
//   unchanged since selection, and only in an evidence mode that may read
//   sources. A URL that a selected item merely mentions (in its text, label,
//   caption or metadata) is not that item's source and is not placed;
// - a blob: URL this run produced itself (runOutputUrls) that no canvas item
//   carries or has carried during the run, or that only items the run placed
//   as its own output carry (runPlacedItemIds: a model, QuickApp or
//   extraction output materialized on the canvas; not a re-placed source).
// Anything else, including a URL that does not parse, a non-blob URL, and
// the URL of an item that is no longer on the canvas, is refused.
export function authorizeCanvasTargetMediaPlacementUrl(options: {
  url: string
  authority: CanvasTargetSelectionAuthority | null | undefined
  evidenceMode: CanvasTargetEvidenceMode
  currentItems: readonly CanvasItem[]
  knownCanvasUrlKeys: ReadonlySet<string>
  runOutputUrls: ReadonlyMap<string, string>
  runPlacedItemIds?: ReadonlySet<string>
}): CanvasTargetMediaPlacementVerdict {
  const key = canvasTargetMediaUrlKey(options.url)
  if (!key || urlSchemeOf(options.url) !== 'blob' || !key.startsWith('blob:')) {
    return { allowed: false, refusal: 'not_run_output', references: [] }
  }

  const matches = findCanvasTargetItemUrlMatches(options.url, options.currentItems)
  const runOutputUrl = options.runOutputUrls.get(key)
  if (matches.length > 0) {
    // The run's own output, already on the canvas only as the items the run
    // placed for it: re-placing it reads nothing the run did not produce.
    const runPlaced = options.runPlacedItemIds
    if (runOutputUrl && runPlaced && matches.every((match) => runPlaced.has(match.id))) {
      return { allowed: true, url: runOutputUrl }
    }
    const verdict = authorizeCanvasTargetSourceReferences({
      authority: options.authority,
      evidenceMode: options.evidenceMode,
      referencedItemIds: matches.map((match) => match.id),
      currentItems: options.currentItems
    })
    if (!verdict.allowed) return verdict
    // Every item that touches the URL passed; the URL is placed only as the
    // media source of one of them, never as a string from another field.
    const scheme = urlSchemeOf(options.url)!
    for (const item of verdict.items) {
      const source = findCanvasItemMediaSourceMatch(item, scheme, key)
      if (source !== null) return { allowed: true, url: source }
    }
    return { allowed: false, refusal: 'not_run_output', references: [] }
  }

  // Carried by a canvas item earlier in the run, but not by any item now:
  // the item was deleted or changed, so it cannot be authorized any more.
  if (options.knownCanvasUrlKeys.has(key)) {
    return { allowed: false, refusal: 'missing', references: [] }
  }

  if (runOutputUrl) return { allowed: true, url: runOutputUrl }
  return { allowed: false, refusal: 'not_run_output', references: [] }
}

// Semantic canvas actions that change or remove items (or groups) that
// already exist. Creating items, selecting, focusing, duplicating and the
// canvas surface state (background, grid, tool) leave existing items as
// they are and are not listed.
const CANVAS_TARGET_ITEM_WRITE_ACTIONS: ReadonlySet<CanvasTargetCanvasAction['action']> = new Set([
  'arrange_items',
  'transform_items',
  'set_z_order',
  'delete_items',
  'clear_canvas',
  'flip_items',
  'crop_image',
  'update_text',
  'update_annotation',
  'set_media_playback',
  'create_group',
  'delete_group',
  'rename_group'
])

export function canvasTargetCanvasActionWritesExistingItems(
  action: Pick<CanvasTargetCanvasAction, 'action'>
): boolean {
  return CANVAS_TARGET_ITEM_WRITE_ACTIONS.has(action.action)
}

export type CanvasTargetCanvasWriteVerdict =
  | { allowed: true }
  | { allowed: false; refusal: 'not_selected'; references: string[] }

// Decide whether a model-planned semantic canvas action may change or remove
// the existing items (and groups) it targets. A run may change only the items
// the user selected when the target dialog opened and the items the run
// created itself; everything else on the board is refused by default. Unlike
// a source read, this does not depend on the evidence mode or on the item
// being unchanged: the run's own earlier edits of a selected item are fine.
// clear_canvas (and a source of 'all_canvas', which resolves to every item)
// is refused whenever the canvas holds any other item. A group action is
// refused when a group it would change holds any other item, in the run's
// view or on the live canvas (liveGroups): the members of both are checked,
// so a view entry that lags behind the live board can only refuse.
//
// Captions attached to an item are part of it: a delete removes them with
// the item, as a manual delete does, and undo restores both. A caption the
// delete takes along is writable when it is selected or run-created, or when
// it was already attached to the same item when the run started
// (runStartAttachedCaptions: caption id -> the item it was attached to). A
// caption attached during the run (the user's new text) refuses the delete.
export function authorizeCanvasTargetCanvasWrite(options: {
  action: CanvasTargetCanvasAction
  state: CanvasTargetSemanticCanvasActionState
  liveGroups?: readonly CanvasGroup[]
  runStartAttachedCaptions?: ReadonlyMap<string, string>
  authority: CanvasTargetSelectionAuthority | null | undefined
  runCreatedItemIds: ReadonlySet<string>
}): CanvasTargetCanvasWriteVerdict {
  const { action, state } = options
  if (!canvasTargetCanvasActionWritesExistingItems(action)) return { allowed: true }
  const selected = new Set(options.authority?.itemIds || [])
  const writable = (itemId: string) => selected.has(itemId) || options.runCreatedItemIds.has(itemId)

  const targetIds =
    action.action === 'clear_canvas'
      ? state.items.map((item) => item.id)
      : resolveCanvasTargetSemanticCanvasActionSourceIds(action, state)
  const targetGroups = resolveCanvasTargetGroupActionTargetGroups(action, state, targetIds)
  const liveTargetGroups = options.liveGroups
    ? resolveCanvasTargetGroupActionTargetGroups(
        action,
        { ...state, groups: [...options.liveGroups] },
        targetIds
      )
    : []
  const targetGroupIds = new Set(targetGroups.map((group) => group.id))
  const groupMemberIds = [
    ...targetGroups,
    ...liveTargetGroups,
    // The live value of every group the view resolved, even when the live
    // group no longer resolves the same way (renamed, membership changed).
    ...(options.liveGroups || []).filter((group) => targetGroupIds.has(group.id))
  ].flatMap((group) => group.itemIds)
  const outside = Array.from(new Set([...targetIds, ...groupMemberIds])).filter(
    (itemId) => !writable(itemId)
  )
  if (action.action === 'delete_items') {
    const targetIdSet = new Set(targetIds)
    const itemById = new Map(state.items.map((item) => [item.id, item] as const))
    const attachedAtRunStart = (itemId: string) => {
      const parentId = options.runStartAttachedCaptions?.get(itemId)
      const caption = itemById.get(itemId)
      return Boolean(
        parentId && caption && isAttachedCaptionAnnotation(caption) && caption.attachedToId === parentId
      )
    }
    collectCascadeDeletedCanvasItemIds(state.items, targetIds).forEach((itemId) => {
      if (targetIdSet.has(itemId) || writable(itemId) || attachedAtRunStart(itemId)) return
      if (!outside.includes(itemId)) outside.push(itemId)
    })
  }
  if (outside.length > 0) return { allowed: false, refusal: 'not_selected', references: outside }
  return { allowed: true }
}

// The captions attached to an item when a run starts (caption id -> the id
// of the item it is attached to). See authorizeCanvasTargetCanvasWrite.
export function collectCanvasTargetAttachedCaptions(
  items: readonly CanvasItem[]
): Map<string, string> {
  const captions = new Map<string, string>()
  for (const item of items) {
    if (isAttachedCaptionAnnotation(item) && item.attachedToId) {
      captions.set(item.id, item.attachedToId)
    }
  }
  return captions
}
