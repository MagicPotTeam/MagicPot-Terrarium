import { getCanvasImageSourceRevisionKey } from './canvasImageResourceLifecycle'
import type { CanvasImageAsset, CanvasItem } from './types'

export const CANVAS_HISTORY_LIMIT = 50

function stripCanvasRuntimeRefs(item: CanvasItem): CanvasItem {
  if (item.type === 'image') {
    const { image: _image, sourceFile: _sourceFile, ...rest } = item
    return rest
  }

  if (item.type === 'model3d' && 'deferRender' in item) {
    const { deferRender: _deferRender, ...rest } = item as CanvasItem & {
      deferRender?: boolean
    }
    return rest
  }

  return item
}

export function createCanvasHistorySnapshot(items: CanvasItem[]): CanvasItem[] {
  return items.map(stripCanvasRuntimeRefs)
}

export function restoreCanvasHistorySnapshot(
  snapshot: CanvasItem[],
  referenceItems: CanvasItem[]
): CanvasItem[] {
  const imageById = new Map<string, { sourceKey: string; image: CanvasImageAsset }>()
  const imageBySource = new Map<string, CanvasImageAsset>()

  for (const item of referenceItems) {
    if (item.type !== 'image' || !item.image || !item.src) {
      continue
    }

    const sourceKey = getCanvasImageSourceRevisionKey(item)
    imageById.set(item.id, { sourceKey, image: item.image })
    if (!imageBySource.has(sourceKey)) {
      imageBySource.set(sourceKey, item.image)
    }
  }

  return snapshot.map((item) => {
    if (item.type !== 'image' || item.image) {
      return item
    }

    const sourceKey = getCanvasImageSourceRevisionKey(item)
    const sameItem = imageById.get(item.id)
    // Undo can restore a different source under the same item id.
    const image = sameItem?.sourceKey === sourceKey ? sameItem.image : imageBySource.get(sourceKey)
    return image ? { ...item, image } : item
  })
}
