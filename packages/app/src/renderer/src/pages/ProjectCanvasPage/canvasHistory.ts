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
  const imageById = new Map<string, CanvasImageAsset>()
  const imageBySrc = new Map<string, CanvasImageAsset>()

  for (const item of referenceItems) {
    if (item.type !== 'image' || !item.image) {
      continue
    }

    imageById.set(item.id, item.image)
    if (!imageBySrc.has(item.src)) {
      imageBySrc.set(item.src, item.image)
    }
  }

  return snapshot.map((item) => {
    if (item.type !== 'image' || item.image) {
      return item
    }

    const image = imageById.get(item.id) ?? imageBySrc.get(item.src)
    return image ? { ...item, image } : item
  })
}
