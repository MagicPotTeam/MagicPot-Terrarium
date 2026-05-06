import {
  useCallback,
  useRef,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction
} from 'react'
import { createCanvasImageItemDraft, createCanvasItemId } from './canvasAssetDraftFactories'
import { createMagicPotNativeProvenance } from './canvasProvenanceUtils'
import {
  placeNextExtractedPieceToRight,
  shiftCanvasItemsToMakeRoom
} from './canvasExtractPlacementUtils'
import { extractImageRegionLocally } from './localImageExtract'
import { getCanvasItemBounds } from './projectCanvasPageShared'
import type { CanvasGroup, CanvasImageItem, CanvasItem } from './types'

type NotifyFn = (message: string) => unknown

type ImageExtractRegion = {
  x: number
  y: number
  width: number
  height: number
}

type UseCanvasImageExtractOptions = {
  items: CanvasItem[]
  groups: CanvasGroup[]
  isChineseUi: boolean
  nextZIndexRef: MutableRefObject<number>
  lastClickedIdRef: MutableRefObject<string | null>
  setGroups: Dispatch<SetStateAction<CanvasGroup[]>>
  setItemsWithHistory: (updater: CanvasItem[] | ((prev: CanvasItem[]) => CanvasItem[])) => void
  setSelectedIds: Dispatch<SetStateAction<Set<string>>>
  hydrateCanvasImageItemForCanvas: (item: CanvasImageItem) => Promise<CanvasImageItem | null>
  loadImageFromSrc: (
    src: string
  ) => Promise<{ img: HTMLImageElement; width: number; height: number }>
  notifySuccess: NotifyFn
  notifyError: NotifyFn
  notifyInfo?: NotifyFn
}

const EXTRACT_NOTE_PREFIX = 'extracted-from-image:'

function stripExtension(fileName: string | undefined, fallback: string) {
  if (!fileName?.trim()) {
    return fallback
  }
  return fileName.replace(/\.[^.]+$/, '') || fallback
}

function isExtractedFromImage(item: CanvasItem, sourceItemId: string): item is CanvasImageItem {
  return Boolean(
    item.type === 'image' &&
    item.provenance?.notes
      ?.split('|')
      .some((note) => note.trim() === `${EXTRACT_NOTE_PREFIX}${sourceItemId}`)
  )
}

function formatExtractSuccessMessage(options: {
  backgroundRemoved: boolean
  confidence: number
  isChineseUi: boolean
}) {
  const { backgroundRemoved, confidence, isChineseUi } = options
  if (!backgroundRemoved) {
    return isChineseUi
      ? '已提取该区域，背景未完全去除，可继续框选其它区域，按 Esc 结束。'
      : 'Extracted the region. Background removal was partial; continue selecting or press Esc to finish.'
  }

  if (confidence < 0.42) {
    return isChineseUi
      ? '已提取并去除背景，可继续框选其它区域，按 Esc 结束。'
      : 'Extracted the region and removed the background. Continue selecting or press Esc to finish.'
  }

  return isChineseUi
    ? '已提取元素并去除背景，可继续框选其它区域，按 Esc 结束。'
    : 'Extracted the element and removed the background. Continue selecting or press Esc to finish.'
}

export function useCanvasImageExtract({
  items,
  groups,
  isChineseUi,
  nextZIndexRef,
  lastClickedIdRef,
  setGroups,
  setItemsWithHistory,
  setSelectedIds,
  hydrateCanvasImageItemForCanvas,
  loadImageFromSrc,
  notifySuccess,
  notifyError,
  notifyInfo
}: UseCanvasImageExtractOptions) {
  const pendingImageIdsRef = useRef(new Set<string>())

  const handleExtractImageRegion = useCallback(
    async (item: CanvasImageItem, region: ImageExtractRegion) => {
      if (!item?.src) {
        notifyError(
          isChineseUi ? '当前图片不可提取。' : 'This image cannot be extracted right now.'
        )
        return
      }

      if (pendingImageIdsRef.current.has(item.id)) {
        notifyInfo?.(
          isChineseUi ? '这张图片正在提取中，请稍候。' : 'This image is already being extracted.'
        )
        return
      }

      pendingImageIdsRef.current.add(item.id)

      try {
        const sourceImage = await loadImageFromSrc(item.src)
        const visibleSourceWidth = item.crop?.width || item.sourceWidth || sourceImage.width
        const visibleSourceHeight = item.crop?.height || item.sourceHeight || sourceImage.height
        const renderedWidth = Math.max(1, Math.abs(item.width * item.scaleX))
        const renderedHeight = Math.max(1, Math.abs(item.height * item.scaleY))
        const pixelsToCanvasScaleX = renderedWidth / Math.max(visibleSourceWidth, 1)
        const pixelsToCanvasScaleY = renderedHeight / Math.max(visibleSourceHeight, 1)

        const extractedRegion = await extractImageRegionLocally({
          item,
          region,
          loadImage: loadImageFromSrc,
          loadedImage: sourceImage
        })

        if (!extractedRegion) {
          notifyInfo?.(
            isChineseUi
              ? '未在所选区域识别到可提取的前景。'
              : 'No extractable foreground was detected inside the selected region.'
          )
          return
        }

        const src = URL.createObjectURL(extractedRegion.blob)
        const existingExtractedItems = items.filter((currentItem) =>
          isExtractedFromImage(currentItem, item.id)
        )
        const extractIndex = existingExtractedItems.length + 1
        const baseName = stripExtension(item.fileName, 'canvas-image')
        const draft = createCanvasImageItemDraft({
          id: createCanvasItemId('canvas-extract'),
          src,
          fileName: `${baseName}-extract-${extractIndex}.png`,
          sizeBytes: extractedRegion.sizeBytes,
          hasAlpha: true,
          sourceWidth: extractedRegion.sourceWidth,
          sourceHeight: extractedRegion.sourceHeight,
          width: Math.max(1, Math.round(extractedRegion.sourceWidth * pixelsToCanvasScaleX)),
          height: Math.max(1, Math.round(extractedRegion.sourceHeight * pixelsToCanvasScaleY)),
          x: 0,
          y: 0,
          zIndex: nextZIndexRef.current++,
          rotation: 0,
          scaleX: 1,
          scaleY: 1,
          locked: false,
          provenance: createMagicPotNativeProvenance({
            notes: `${EXTRACT_NOTE_PREFIX}${item.id}`
          })
        })

        const hydratedItem = await hydrateCanvasImageItemForCanvas(draft)
        if (!hydratedItem) {
          URL.revokeObjectURL(src)
          notifyError(
            isChineseUi ? '提取结果生成失败。' : 'Failed to build the extracted image asset.'
          )
          return
        }

        let placedExtractedItem: CanvasImageItem = hydratedItem

        setItemsWithHistory((previousItems) => {
          const currentSourceItem = previousItems.find(
            (previousItem) => previousItem.id === item.id && previousItem.type === 'image'
          ) as CanvasImageItem | undefined
          const anchorItem = currentSourceItem ?? item
          const anchorBounds = getCanvasItemBounds(anchorItem)
          const latestExtractedItems = previousItems.filter((currentItem) =>
            isExtractedFromImage(currentItem, item.id)
          )
          const { placement, bounds: placementBounds } = placeNextExtractedPieceToRight(
            anchorBounds,
            latestExtractedItems.map((existingItem) => ({
              id: existingItem.id,
              x: existingItem.x,
              y: existingItem.y,
              width: existingItem.width,
              height: existingItem.height
            })),
            {
              id: hydratedItem.id,
              width: hydratedItem.width,
              height: hydratedItem.height
            }
          )

          placedExtractedItem = {
            ...hydratedItem,
            x: placement.x,
            y: placement.y
          }

          const preservedIds = new Set<string>([
            anchorItem.id,
            ...latestExtractedItems.map((current) => current.id)
          ])
          const shiftedItems = shiftCanvasItemsToMakeRoom(
            previousItems,
            placementBounds,
            preservedIds
          )

          return [...shiftedItems, placedExtractedItem]
        })

        const hostGroup = groups.find((group) => group.itemIds.includes(item.id)) ?? null
        if (hostGroup) {
          setGroups((prev) =>
            prev.map((group) =>
              group.id === hostGroup.id && !group.itemIds.includes(placedExtractedItem.id)
                ? {
                    ...group,
                    itemIds: [...group.itemIds, placedExtractedItem.id]
                  }
                : group
            )
          )
        }

        setSelectedIds(new Set([item.id]))
        lastClickedIdRef.current = item.id
        notifySuccess(
          formatExtractSuccessMessage({
            backgroundRemoved: extractedRegion.backgroundRemoved,
            confidence: extractedRegion.confidence,
            isChineseUi
          })
        )
      } catch (error) {
        console.error('[Canvas] Failed to extract image region locally.', error)
        notifyError(
          isChineseUi ? '提取图片区域失败。' : 'Failed to extract the selected image region.'
        )
      } finally {
        pendingImageIdsRef.current.delete(item.id)
      }
    },
    [
      groups,
      hydrateCanvasImageItemForCanvas,
      isChineseUi,
      items,
      lastClickedIdRef,
      loadImageFromSrc,
      nextZIndexRef,
      notifyError,
      notifyInfo,
      notifySuccess,
      setGroups,
      setItemsWithHistory,
      setSelectedIds
    ]
  )

  return {
    handleExtractImageRegion
  }
}
