// packages/app/src/renderer/src/pages/ProjectCanvasPage/canvasItemSerialization.ts
// The persisted form of canvas items, and the dirty signature derived from it.
import type { CanvasFigmaBinding } from '@shared/figma'
import type { CanvasGroup, CanvasGroupBranch, CanvasItem } from './types'

// Serializable canvas items without DOM-only fields.
export type SerializableCanvasItem = Omit<CanvasItem, 'image'> & { image?: never }

/** In-memory content-key tags of a restored item; never part of the persisted form. */
export type CanvasAssetKeyTagged = {
  assetKey?: unknown
  assetKeySource?: unknown
  textureAssetKeys?: unknown
  textureAssetKeySources?: unknown
}

/** Drops the in-memory key tags; the save path writes the persisted ones itself. */
export function stripCanvasAssetKeyTags<T extends object>(item: T): T {
  const tagged = item as T & CanvasAssetKeyTagged
  if (
    tagged.assetKey === undefined &&
    tagged.assetKeySource === undefined &&
    tagged.textureAssetKeys === undefined &&
    tagged.textureAssetKeySources === undefined
  ) {
    return item
  }
  const {
    assetKey: _assetKey,
    assetKeySource: _assetKeySource,
    textureAssetKeys: _textureAssetKeys,
    textureAssetKeySources: _textureAssetKeySources,
    ...rest
  } = tagged
  return rest as T
}

/**
 * Serialize one canvas item and drop non-serializable fields such as HTMLImageElement.
 */
export function serializeCanvasItem(item: CanvasItem): SerializableCanvasItem {
  if (item.type === 'image') {
    const { image, sourceFile, thumbnailSet: _thumbnailSet, sourceIdentity, ...rest } = item
    const persistedSourceIdentity =
      sourceIdentity?.kind === 'local-file' ? sourceIdentity : undefined
    // Source-size hints may come from stale thumbnail or display metadata.
    // Without pixel provenance, even a geometrical identity can be a crop.
    // Persist it verbatim; source and crop remain separate in project mirrors.
    return stripCanvasAssetKeyTags({
      ...rest,
      ...(persistedSourceIdentity ? { sourceIdentity: persistedSourceIdentity } : {})
    }) as SerializableCanvasItem
  }
  if (item.type === 'model3d') {
    const { deferRender, sourceFile, ...rest } = item as CanvasItem & {
      deferRender?: boolean
      sourceFile?: Blob
    }
    return stripCanvasAssetKeyTags(rest) as SerializableCanvasItem
  }
  if (item.type === 'video' || item.type === 'file') {
    const { sourceFile, ...rest } = item
    return stripCanvasAssetKeyTags(rest) as SerializableCanvasItem
  }
  return item as SerializableCanvasItem
}

export function serializeCanvasItems(items: readonly CanvasItem[]): SerializableCanvasItem[] {
  return items.map(serializeCanvasItem)
}

// ─── Dirty signature ─────────────────────────────────────────────────────────
// What a save would write, as text: one string per item (cached per item
// object, so an edit serialises only the items it replaced) plus the groups,
// branches and Figma binding. Fields a save does not persist (decoded image,
// source file, thumbnail set, session-only source identity, in-memory asset
// tags) are not part of it and therefore never make the board dirty.
export type CanvasPersistenceSignature = {
  readonly items: readonly string[]
  readonly rest: string
}

const canvasItemSignatureCache = new WeakMap<object, string>()

function getCanvasItemPersistenceSignature(item: CanvasItem): string {
  let signature = canvasItemSignatureCache.get(item)
  if (signature === undefined) {
    signature = JSON.stringify(serializeCanvasItem(item)) ?? ''
    canvasItemSignatureCache.set(item, signature)
  }
  return signature
}

export function buildCanvasPersistenceSignature(
  items: readonly CanvasItem[],
  groups: readonly CanvasGroup[],
  groupBranches: readonly CanvasGroupBranch[],
  figmaBinding: CanvasFigmaBinding | null
): CanvasPersistenceSignature {
  const itemSignatures = new Array<string>(items.length)
  for (let index = 0; index < items.length; index += 1) {
    itemSignatures[index] = getCanvasItemPersistenceSignature(items[index])
  }
  return {
    items: itemSignatures,
    rest: JSON.stringify({ groups, groupBranches, figmaBinding })
  }
}

export function areCanvasPersistenceSignaturesEqual(
  left: CanvasPersistenceSignature | null,
  right: CanvasPersistenceSignature | null
): boolean {
  if (left === right) return true
  if (!left || !right) return false
  if (left.rest !== right.rest || left.items.length !== right.items.length) return false
  for (let index = 0; index < left.items.length; index += 1) {
    if (left.items[index] !== right.items[index]) return false
  }
  return true
}
