import type { ResultItem } from '@shared/qApp/resultTypes'

export type QAppCanvasDispatchCounts = {
  imageCount: number
  videoCount: number
  totalCount: number
}

export type QAppCanvasDispatchOptions = {
  onCanvasItemAdded?: (item: unknown) => void
}

const hasTransferableObjectUrl = (
  item: ResultItem
): item is Extract<ResultItem, { type: 'image' | 'video' }> => {
  return (
    (item.type === 'image' || item.type === 'video') &&
    typeof item.objectUrl === 'string' &&
    item.objectUrl.trim().length > 0
  )
}

const getPositiveDimension = (value: unknown) => {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

export const dispatchQAppResultsToCanvas = (
  resultItems: ResultItem[],
  projectId?: string,
  generationSessionId?: string,
  options?: QAppCanvasDispatchOptions
): QAppCanvasDispatchCounts => {
  const imageItems: Extract<ResultItem, { type: 'image' }>[] = []
  const videoItems: Extract<ResultItem, { type: 'video' }>[] = []

  for (const item of resultItems) {
    if (item.type === 'image' && hasTransferableObjectUrl(item)) {
      imageItems.push(item)
      continue
    }

    if (item.type === 'video' && hasTransferableObjectUrl(item)) {
      videoItems.push(item)
    }
  }

  let imageCount = 0
  let videoCount = 0

  imageCount = imageItems.length
  videoCount = videoItems.length

  window.setTimeout(() => {
    for (const item of imageItems) {
      window.dispatchEvent(
        new CustomEvent('canvas:add-image', {
          detail: {
            src: item.objectUrl,
            fileName: item.fileItem.filename,
            projectId,
            generationSessionId,
            newResultHint: 'quickapp',
            select: false,
            promptId: item.promptId,
            fileItem: item.fileItem,
            sourceFile: item.sourceBlob,
            onAdded: options?.onCanvasItemAdded,
            ...(getPositiveDimension(item.sourceWidth) != null
              ? { sourceWidth: getPositiveDimension(item.sourceWidth) }
              : {}),
            ...(getPositiveDimension(item.sourceHeight) != null
              ? { sourceHeight: getPositiveDimension(item.sourceHeight) }
              : {})
          }
        })
      )
    }

    for (const item of videoItems) {
      window.dispatchEvent(
        new CustomEvent('canvas:add-video', {
          detail: {
            src: item.objectUrl,
            fileName: item.fileItem.filename,
            projectId,
            generationSessionId,
            select: false,
            promptId: item.promptId,
            fileItem: item.fileItem,
            onAdded: options?.onCanvasItemAdded
          }
        })
      )
    }
  }, 0)

  return {
    imageCount,
    videoCount,
    totalCount: imageCount + videoCount
  }
}
