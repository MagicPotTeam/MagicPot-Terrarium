/* eslint-disable @typescript-eslint/no-explicit-any */
import { useCallback, useEffect, useMemo } from 'react'
import { api } from '../../utils/windowUtils'
import { cloneHy3dMediaState } from '../ChatPage/hy3d/types'
import {
  buildCanvasAgentAttachmentManifest,
  buildCanvasAgentAttachments,
  buildCanvasImageCropSourceMetadata,
  CANVAS_IMAGE_CROP_SOURCE_METADATA_KEY,
  expandCanvasItemsForAgentSend,
  materializeCanvasAgentAttachmentItemsSync
} from './canvasAgentAttachmentUtils'
import { isCanvasAdditiveSelectionModifier } from './canvasSelectionModifiers'
import { FILLED_ANNOTATION_OPACITY, type CanvasDragPayload } from './projectCanvasPageShared'
import { formatProjectCanvasScalePercent } from './projectCanvasViewportScale'
import { scheduleCanvasSync } from './components/canvasSync'
import type {
  CanvasAnnotationItem,
  CanvasFileItem,
  CanvasImageItem,
  CanvasItem,
  CanvasModel3DItem,
  CanvasTextItem,
  CanvasVideoItem
} from './types'
import { useCanvasExternalDrop } from './useCanvasExternalDrop'

type UseCanvasSelectionUiActionsOptions = any
type CanvasContextMenuNativeEvent = MouseEvent | PointerEvent
type CanvasImageContextMenuEvent =
  | CanvasContextMenuNativeEvent
  | {
      evt: CanvasContextMenuNativeEvent
      cancelBubble?: boolean
    }

const CANVAS_DRAG_FALLBACK_TEXT = 'MagicPot canvas asset'
const MAX_CANVAS_DRAG_TEXT_PLAIN_LENGTH = 2000

type CanvasDragPayloadBuildOptions = {
  objectUrl?: string
  previewImageUrl?: string
  promptId?: string
}

function getSafeCanvasDragPlainText(payload: CanvasDragPayload): string {
  const textContent =
    typeof payload.textContent === 'string' && payload.textContent.trim()
      ? payload.textContent.trim()
      : ''

  if (
    !textContent ||
    textContent.length > MAX_CANVAS_DRAG_TEXT_PLAIN_LENGTH ||
    textContent.startsWith('MAGICPOT_DRAG::') ||
    textContent.includes('data:image')
  ) {
    return CANVAS_DRAG_FALLBACK_TEXT
  }

  return textContent
}

function getCanvasImageContextMenuNativeEvent(
  event: CanvasImageContextMenuEvent
): CanvasContextMenuNativeEvent {
  return 'evt' in event ? event.evt : event
}

export function useCanvasSelectionUiActions(options: UseCanvasSelectionUiActionsOptions) {
  const {
    alpha,
    annoTool,
    annotationColor,
    annotationFillOpacity,
    annotationStrokeWidth,
    canvasContainerRef,
    canvasId,
    contextMenuTarget,
    extractPromptTextFromCanvasItems,
    getCanvasItemsBounds,
    handleCopyCanvasItemsAsImage,
    handleDownloadCanvasItemsAsImage,
    handleSendCanvasItemsSnapshotToPhotoshop,
    handleSendSelectionToAgent,
    isChineseUi,
    isFillableAnnotationShape,
    items,
    labelDialogItemId,
    labelDialogText,
    nextZIndex,
    notifyError,
    notifySuccess,
    selectedIds,
    setAnnotationFillOpacity,
    setContextMenuTarget,
    setCroppingImageId,
    setExtractingImageId,
    setImageContextMenu,
    setItems,
    setItemsWithHistory,
    setLabelDialogOpen,
    setPendingTextureModelId,
    setSelectedIds,
    setTextureImportDialogOpen,
    setTool,
    stagePos,
    stageScale,
    t,
    theme,
    tool,
    tryHandleCanvasExternalDropRef,
    actionMessageKeyRef
  } = options

  const scalePercent = formatProjectCanvasScalePercent(stageScale)
  const isLightCanvasTheme = theme.palette.mode === 'light'
  const annotationToolbarBorderColor = isLightCanvasTheme
    ? alpha(theme.palette.common.black, 0.12)
    : alpha(theme.palette.common.white, 0.08)
  const annotationToolbarSurface = isLightCanvasTheme
    ? alpha(theme.palette.background.paper, 0.96)
    : alpha('#0f1014', 0.94)
  const annotationToolbarIdleSurface = isLightCanvasTheme
    ? alpha(theme.palette.common.black, 0.03)
    : alpha(theme.palette.common.white, 0.04)
  const annotationToolbarHoverSurface = isLightCanvasTheme
    ? alpha(theme.palette.common.black, 0.06)
    : alpha(theme.palette.common.white, 0.08)
  const annotationToolbarStrongText = isLightCanvasTheme
    ? alpha(theme.palette.text.primary, 0.86)
    : alpha(theme.palette.common.white, 0.86)
  const annotationToolbarMutedText = isLightCanvasTheme
    ? alpha(theme.palette.text.primary, 0.58)
    : alpha(theme.palette.common.white, 0.52)
  const annotationToolbarShadow = isLightCanvasTheme
    ? '0 10px 22px rgba(15,23,42,0.12), inset 0 1px 0 rgba(255,255,255,0.72)'
    : '0 10px 24px rgba(0,0,0,0.22), inset 0 1px 0 rgba(255,255,255,0.04)'

  const countLabel = useMemo(() => {
    if (selectedIds.size > 0) {
      const selectedItems = items.filter((item: CanvasItem) => selectedIds.has(item.id))
      if (selectedItems.length > 0) {
        const bounds = getCanvasItemsBounds(selectedItems)
        const width = Math.round((bounds?.maxX || 0) - (bounds?.minX || 0))
        const height = Math.round((bounds?.maxY || 0) - (bounds?.minY || 0))
        if (width > 0 && height > 0) {
          if (selectedItems.length > 1) {
            return t('canvas.status_selected_items', {
              count: selectedItems.length,
              w: width,
              h: height
            })
          }
          return `${width} x ${height}`
        }
      }
    }

    const validItems = items.filter((item: CanvasItem) => {
      if ((item as any).isDeleted || (item as any).deleted) return false
      if (item.type === 'text' && !(item as CanvasTextItem).text?.trim()) return false
      if (item.type === 'annotation' && item.shape === 'text-anno' && !item.text?.trim()) {
        return false
      }
      return true
    })

    return validItems.length > 0
      ? t('canvas.status_total_items', { count: validItems.length })
      : t('canvas.status_empty_canvas')
  }, [getCanvasItemsBounds, items, selectedIds, t])

  const hasSelectedStrokeItem = useMemo(() => {
    for (const item of items as CanvasItem[]) {
      if (selectedIds.has(item.id) && item.type === 'annotation' && item.shape !== 'text-anno') {
        return true
      }
    }
    return false
  }, [items, selectedIds])

  const hasSelectedTextItem = useMemo(() => {
    for (const item of items as CanvasItem[]) {
      if (!selectedIds.has(item.id)) continue
      if (item.type === 'text') return true
      if (item.type === 'annotation' && item.shape === 'text-anno') return true
    }
    return false
  }, [items, selectedIds])

  const selectedFillableAnnotationItems = useMemo(
    () =>
      items.filter(
        (item: CanvasItem): item is CanvasAnnotationItem =>
          selectedIds.has(item.id) &&
          item.type === 'annotation' &&
          isFillableAnnotationShape(item.shape)
      ),
    [isFillableAnnotationShape, items, selectedIds]
  )

  const hasSelectedFillableAnnotationItem = selectedFillableAnnotationItems.length > 0
  const annotationFillEnabled = hasSelectedFillableAnnotationItem
    ? selectedFillableAnnotationItems.some((item) => item.fillOpacity > 0)
    : isFillableAnnotationShape(annoTool) && annotationFillOpacity > 0
  const showAnnotationFillToggle =
    (tool === 'annotate' && isFillableAnnotationShape(annoTool)) ||
    hasSelectedFillableAnnotationItem
  const showAnnotationStrokeControl =
    tool === 'annotate' || hasSelectedStrokeItem || hasSelectedTextItem

  useEffect(() => {
    if (!hasSelectedFillableAnnotationItem) return
    setAnnotationFillOpacity(annotationFillEnabled ? FILLED_ANNOTATION_OPACITY : 0)
  }, [annotationFillEnabled, hasSelectedFillableAnnotationItem, setAnnotationFillOpacity])

  const handleToggleAnnotationFillMode = useCallback(() => {
    const nextOpacity = annotationFillEnabled ? 0 : FILLED_ANNOTATION_OPACITY
    setAnnotationFillOpacity(nextOpacity)

    if (!hasSelectedFillableAnnotationItem) return

    setItemsWithHistory(
      (prev: CanvasItem[]) =>
        prev.map((item) => {
          if (!selectedIds.has(item.id)) return item
          if (item.type !== 'annotation' || !isFillableAnnotationShape(item.shape)) return item
          return { ...item, fillOpacity: nextOpacity }
        }) as CanvasItem[]
    )
  }, [
    annotationFillEnabled,
    hasSelectedFillableAnnotationItem,
    isFillableAnnotationShape,
    selectedIds,
    setAnnotationFillOpacity,
    setItemsWithHistory
  ])

  const handleImageContextMenu = useCallback(
    (event: CanvasImageContextMenuEvent, item: CanvasItem) => {
      const nativeEvent = getCanvasImageContextMenuNativeEvent(event)
      nativeEvent.preventDefault()
      if ('cancelBubble' in event) {
        event.cancelBubble = true
      }
      setImageContextMenu({
        mouseX: nativeEvent.clientX + 2,
        mouseY: nativeEvent.clientY + 4
      })
      setContextMenuTarget(item)
      if (!selectedIds.has(item.id)) {
        setSelectedIds((prev: Set<string>) => {
          if (isCanvasAdditiveSelectionModifier(nativeEvent)) {
            const next = new Set(prev)
            next.add(item.id)
            return next
          }
          return new Set([item.id])
        })
      }
    },
    [selectedIds, setContextMenuTarget, setImageContextMenu, setSelectedIds]
  )

  const handleCloseImageContextMenu = useCallback(() => {
    setImageContextMenu(null)
    setContextMenuTarget(null)
  }, [setContextMenuTarget, setImageContextMenu])

  const handleBringToFront = useCallback(() => {
    if (!contextMenuTarget) return
    setItemsWithHistory((prev: CanvasItem[]) => {
      const maxZ = Math.max(...prev.map((item) => item.zIndex), 0)
      return prev.map((item) =>
        item.id === contextMenuTarget.id ? { ...item, zIndex: maxZ + 1 } : item
      ) as CanvasItem[]
    })
    handleCloseImageContextMenu()
  }, [contextMenuTarget, handleCloseImageContextMenu, setItemsWithHistory])

  const handleSendToBack = useCallback(() => {
    if (!contextMenuTarget) return
    setItemsWithHistory((prev: CanvasItem[]) => {
      const minZ = Math.min(...prev.map((item) => item.zIndex), 0)
      return prev.map((item) =>
        item.id === contextMenuTarget.id ? { ...item, zIndex: minZ - 1 } : item
      ) as CanvasItem[]
    })
    handleCloseImageContextMenu()
  }, [contextMenuTarget, handleCloseImageContextMenu, setItemsWithHistory])

  const handleBringForward = useCallback(() => {
    if (!contextMenuTarget) return
    setItemsWithHistory((prev: CanvasItem[]) => {
      const sorted = [...prev].sort((a, b) => a.zIndex - b.zIndex)
      const index = sorted.findIndex((item) => item.id === contextMenuTarget.id)
      if (index === -1 || index === sorted.length - 1) return prev
      const nextItem = sorted[index + 1]
      return prev.map((item) => {
        if (item.id === contextMenuTarget.id) return { ...item, zIndex: nextItem.zIndex }
        if (item.id === nextItem.id) return { ...item, zIndex: contextMenuTarget.zIndex }
        return item
      }) as CanvasItem[]
    })
    handleCloseImageContextMenu()
  }, [contextMenuTarget, handleCloseImageContextMenu, setItemsWithHistory])

  const handleSendBackward = useCallback(() => {
    if (!contextMenuTarget) return
    setItemsWithHistory((prev: CanvasItem[]) => {
      const sorted = [...prev].sort((a, b) => a.zIndex - b.zIndex)
      const index = sorted.findIndex((item) => item.id === contextMenuTarget.id)
      if (index <= 0) return prev
      const previousItem = sorted[index - 1]
      return prev.map((item) => {
        if (item.id === contextMenuTarget.id) return { ...item, zIndex: previousItem.zIndex }
        if (item.id === previousItem.id) return { ...item, zIndex: contextMenuTarget.zIndex }
        return item
      }) as CanvasItem[]
    })
    handleCloseImageContextMenu()
  }, [contextMenuTarget, handleCloseImageContextMenu, setItemsWithHistory])

  const handleOpenTextureImportFromContextMenu = useCallback(
    (itemId: string) => {
      handleCloseImageContextMenu()
      setPendingTextureModelId(itemId)
      setTextureImportDialogOpen(true)
    },
    [handleCloseImageContextMenu, setPendingTextureModelId, setTextureImportDialogOpen]
  )

  const handleConfirmLabelDialog = useCallback(() => {
    if (labelDialogItemId) {
      setItemsWithHistory(
        (prev: CanvasItem[]) =>
          prev.map((item) =>
            item.id === labelDialogItemId && item.type === 'annotation'
              ? { ...item, label: labelDialogText }
              : item
          ) as CanvasItem[]
      )
    }
    setLabelDialogOpen(false)
  }, [labelDialogItemId, labelDialogText, setItemsWithHistory, setLabelDialogOpen])

  const handleSmartCleanup = useCallback(async () => {
    const targetItems =
      selectedIds.size > 1 ? items.filter((item: CanvasItem) => selectedIds.has(item.id)) : items

    if (targetItems.length < 2) {
      notifySuccess(
        isChineseUi
          ? '\u8bf7\u81f3\u5c11\u9009\u62e9\u4e24\u4e2a\u5143\u7d20\u540e\u518d\u6267\u884c\u667a\u80fd\u6574\u7406\u3002'
          : 'Select at least two items before running smart cleanup.'
      )
      return
    }

    const backupItems = [...items]
    const loadingId = `text-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

    setItems((prev: CanvasItem[]) => [
      ...prev,
      {
        id: loadingId,
        type: 'text',
        text: isChineseUi
          ? 'AI \u6b63\u5728\u667a\u80fd\u6574\u7406\u5e03\u5c40\u2026'
          : 'AI is cleaning up the layout...',
        fontSize: 16,
        fontFamily: 'system-ui',
        fill: '#00bcd4',
        width: 300,
        height: 40,
        x: -stagePos.x / stageScale + 50,
        y: -stagePos.y / stageScale + 50,
        zIndex: nextZIndex.current++,
        rotation: 0,
        scaleX: 1,
        scaleY: 1,
        locked: true
      } as CanvasTextItem
    ])

    try {
      const layoutData = targetItems.map((item: CanvasItem) => {
        let content = ''
        if (item.type === 'text') content = (item as any).text || ''
        if (item.type === 'annotation') content = (item as any).label || (item as any).text || ''
        return {
          id: item.id,
          type: item.type,
          x: Math.round(item.x),
          y: Math.round(item.y),
          w: Math.round(item.width),
          h: Math.round(item.height),
          content: content.slice(0, 100)
        }
      })

      if (!api().svcLLMProxy) {
        throw new Error(
          isChineseUi
            ? 'LLM \u670d\u52a1\u5c1a\u672a\u914d\u7f6e\u3002'
            : 'LLM service is not configured.'
        )
      }

      const profilesResult = await api().svcLLMProxy.listProfiles({})
      const defaultProfile = profilesResult.profiles[0]
      if (!defaultProfile) {
        throw new Error(
          isChineseUi
            ? '\u5f53\u524d\u6ca1\u6709\u53ef\u7528\u7684 AI \u914d\u7f6e\u3002'
            : 'No available AI profile was found.'
        )
      }

      const prompt = `You are a canvas layout cleanup assistant. Rearrange the following items so the layout is cleaner, spacing is more even, and overlaps are minimized.
Requirements:
1. Return JSON only with no explanation.
2. Do not add, remove, or rename items. Preserve every original id.
3. Do not change item sizes. Only adjust x and y.
4. Include only moved items in updates and use numeric coordinates.
5. If two items have an obvious flow or reference relationship, you may return from/to entries in connections; otherwise return an empty array.
6. Prefer preserving reading order and grouping.

Items:
${JSON.stringify(layoutData, null, 2)}

Return shape:
{
  "updates": [ { "id": "...", "x": 100, "y": 200 } ],
  "connections": [ { "from": "id1", "to": "id2" } ]
}`

      const response = await api().svcLLMProxy.chat({
        profileId: defaultProfile.id,
        messages: [{ role: 'user', content: prompt }]
      })

      const layoutResult = JSON.parse(
        (response?.content || '')
          .replace(/```json/gi, '')
          .replace(/```/gi, '')
          .trim()
      )

      setItemsWithHistory((prev: CanvasItem[]) => {
        let nextItems = [...prev].filter((item) => item.id !== loadingId)

        if (Array.isArray(layoutResult.updates)) {
          nextItems = nextItems.map((item) => {
            const update = layoutResult.updates.find((entry: any) => entry.id === item.id)
            return update ? { ...item, x: update.x, y: update.y } : item
          }) as CanvasItem[]
        }

        if (Array.isArray(layoutResult.connections)) {
          layoutResult.connections.forEach((connection: any) => {
            const fromItem = nextItems.find((item) => item.id === connection.from)
            const toItem = nextItems.find((item) => item.id === connection.to)
            if (!fromItem || !toItem) return

            nextItems.push({
              id: `anno-arrow-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
              type: 'annotation',
              shape: 'arrow',
              x: fromItem.x + fromItem.width / 2,
              y: fromItem.y + fromItem.height / 2,
              endX: toItem.x + toItem.width / 2,
              endY: toItem.y + toItem.height / 2,
              width: 10,
              height: 10,
              rotation: 0,
              scaleX: 1,
              scaleY: 1,
              zIndex: nextZIndex.current++,
              stroke: '#00bcd4',
              strokeWidth: 2,
              fillOpacity: 0,
              locked: false,
              label: ''
            } as CanvasAnnotationItem)
          })
        }

        return nextItems
      })

      notifySuccess(
        isChineseUi ? 'AI \u667a\u80fd\u6574\u7406\u5df2\u5b8c\u6210\u3002' : 'AI cleanup complete.'
      )
    } catch (error: any) {
      console.error('[Smart Cleanup]', error)
      notifyError(
        `${isChineseUi ? 'AI \u667a\u80fd\u6574\u7406\u5931\u8d25' : 'AI cleanup failed'}: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
      setItems(backupItems)
    }
  }, [
    isChineseUi,
    items,
    nextZIndex,
    notifyError,
    notifySuccess,
    selectedIds,
    setItems,
    setItemsWithHistory,
    stagePos,
    stageScale
  ])

  const handleCopyCanvasImage = useCallback(
    async (item?: CanvasItem) => {
      const targetItem = (item || contextMenuTarget) as CanvasImageItem | undefined
      if (!targetItem) return
      if (!item) handleCloseImageContextMenu()
      await handleCopyCanvasItemsAsImage([targetItem])
    },
    [contextMenuTarget, handleCloseImageContextMenu, handleCopyCanvasItemsAsImage]
  )

  const handleDownloadCanvasImage = useCallback(
    async (item?: CanvasItem) => {
      const targetItem = (item || contextMenuTarget) as CanvasImageItem | undefined
      if (!targetItem) return
      if (!item) handleCloseImageContextMenu()
      await handleDownloadCanvasItemsAsImage(
        [targetItem],
        targetItem.fileName?.replace(/\.[^.]+$/, '') || 'canvas-image'
      )
    },
    [contextMenuTarget, handleCloseImageContextMenu, handleDownloadCanvasItemsAsImage]
  )

  const handleSendToPhotoshop = useCallback(
    async (item?: CanvasItem) => {
      const targetItem = (item || contextMenuTarget) as CanvasImageItem | undefined
      if (!targetItem) return
      if (!item) handleCloseImageContextMenu()
      await handleSendCanvasItemsSnapshotToPhotoshop([targetItem])
    },
    [contextMenuTarget, handleCloseImageContextMenu, handleSendCanvasItemsSnapshotToPhotoshop]
  )

  const buildCanvasDragPayload = useCallback(
    (targetItems: CanvasItem[], options?: CanvasDragPayloadBuildOptions): CanvasDragPayload => {
      const expandedTargetItems = expandCanvasItemsForAgentSend(targetItems, items)
      const attachmentSourceItems = materializeCanvasAgentAttachmentItemsSync(expandedTargetItems)
      const dragManifestItems = attachmentSourceItems.map((item) => {
        if (item.type !== 'image') return item

        const cropSource = buildCanvasImageCropSourceMetadata(item)
        if (!cropSource) return item

        const outputWidth = Math.max(1, Math.round(cropSource.crop.width))
        const outputHeight = Math.max(1, Math.round(cropSource.crop.height))
        const { crop: _crop, ...itemWithoutCrop } = item
        return {
          ...itemWithoutCrop,
          fileName: cropSource.fileName,
          sourceWidth: outputWidth,
          sourceHeight: outputHeight,
          width: outputWidth,
          height: outputHeight
        } as CanvasImageItem
      })
      const originalImageItems = attachmentSourceItems.filter(
        (item): item is CanvasImageItem => item.type === 'image'
      )
      let imageAttachmentIndex = 0
      const attachments = buildCanvasAgentAttachments(dragManifestItems).map((attachment) => {
        if (attachment.type !== 'image') return attachment

        const sourceItem = originalImageItems[imageAttachmentIndex++]
        const cropSource = sourceItem ? buildCanvasImageCropSourceMetadata(sourceItem) : null
        if (!cropSource) return attachment

        return {
          ...attachment,
          url: cropSource.url,
          fileName: cropSource.fileName,
          mimeType: 'image/png',
          sizeBytes: undefined,
          sourceWidth: Math.max(1, Math.round(cropSource.crop.width)),
          sourceHeight: Math.max(1, Math.round(cropSource.crop.height)),
          metadata: {
            ...(attachment.metadata || {}),
            [CANVAS_IMAGE_CROP_SOURCE_METADATA_KEY]: cropSource
          }
        }
      })
      const singleDragImageItem =
        dragManifestItems.length === 1 && dragManifestItems[0]?.type === 'image'
          ? (dragManifestItems[0] as CanvasImageItem)
          : null
      const hy3dSourceItem =
        targetItems.length === 1 && targetItems[0]?.type === 'model3d'
          ? (targetItems[0] as CanvasModel3DItem)
          : null
      const itemTypes =
        attachments.length > 0
          ? Array.from(
              new Set(
                attachments.map((attachment) =>
                  attachment.type === 'model3d'
                    ? 'model3d'
                    : attachment.type === 'video'
                      ? 'video'
                      : attachment.type === 'image'
                        ? 'image'
                        : 'file'
                )
              )
            )
          : undefined

      return {
        objectUrl:
          singleDragImageItem?.src || (options?.objectUrl?.trim() ? options.objectUrl : undefined),
        previewImageUrl:
          singleDragImageItem?.src ||
          (options?.previewImageUrl?.trim() ? options.previewImageUrl : undefined),
        promptId: options?.promptId?.trim() ? options.promptId : undefined,
        sourceCanvasId: canvasId,
        attachments: attachments.length > 0 ? attachments : undefined,
        itemTypes,
        textContent: extractPromptTextFromCanvasItems(expandedTargetItems).trim() || undefined,
        hiddenTextContent:
          buildCanvasAgentAttachmentManifest(dragManifestItems).trim() || undefined,
        ...(hy3dSourceItem?.hy3dQuickAppKey
          ? { hy3dQuickAppKey: hy3dSourceItem.hy3dQuickAppKey }
          : {}),
        ...(hy3dSourceItem?.hy3dParams ? { hy3dParams: { ...hy3dSourceItem.hy3dParams } } : {}),
        ...(hy3dSourceItem?.hy3dMediaState
          ? { hy3dMediaState: cloneHy3dMediaState(hy3dSourceItem.hy3dMediaState) }
          : {})
      }
    },
    [canvasId, extractPromptTextFromCanvasItems, items]
  )

  const setCanvasDragPayload = useCallback(
    (dataTransfer: DataTransfer, payload: CanvasDragPayload) => {
      const payloadStr = JSON.stringify(payload)
      dataTransfer.setData('application/x-qapp-image', payloadStr)
      dataTransfer.setData('text/plain', getSafeCanvasDragPlainText(payload))
      dataTransfer.effectAllowed = 'copy'
    },
    []
  )

  const getCanvasImageDragObjectUrl = useCallback((item: CanvasImageItem) => item.src || '', [])

  const resetDraggedItemNode = useCallback(
    (item: CanvasImageItem | CanvasModel3DItem | CanvasVideoItem | CanvasFileItem) => {
      if (item.type === 'image') {
        return
      }
      window.dispatchEvent(new CustomEvent(`canvas-reset-${item.id}`))

      if (item.type === 'model3d' || item.type === 'video') {
        scheduleCanvasSync(item.id, {
          x: item.x,
          y: item.y,
          rotation: item.rotation,
          scaleX: item.scaleX,
          scaleY: item.scaleY
        })
      }
    },
    []
  )

  const { tryHandleCanvasExternalDrop } = useCanvasExternalDrop({
    canvasId,
    items,
    canvasContainerRef,
    buildCanvasDragPayload,
    setCanvasDragPayload,
    getCanvasImageDragObjectUrl,
    resetDraggedItemNode,
    handleSendSelectionToAgent
  })
  tryHandleCanvasExternalDropRef.current = tryHandleCanvasExternalDrop

  const handleFlipImage = useCallback(
    (item: CanvasImageItem) => {
      const rotationRad = (item.rotation * Math.PI) / 180
      const cos = Math.cos(rotationRad)
      const sin = Math.sin(rotationRad)
      const rotatePoint = (x: number, y: number) => ({
        x: x * cos - y * sin,
        y: x * sin + y * cos
      })

      const currentCenterOffset = rotatePoint(
        (item.width * item.scaleX) / 2,
        (item.height * item.scaleY) / 2
      )
      const worldCenter = {
        x: item.x + currentCenterOffset.x,
        y: item.y + currentCenterOffset.y
      }
      const nextScaleX = item.scaleX * -1
      const nextCenterOffset = rotatePoint(
        (item.width * nextScaleX) / 2,
        (item.height * item.scaleY) / 2
      )
      const nextX = worldCenter.x - nextCenterOffset.x
      const nextY = worldCenter.y - nextCenterOffset.y

      setItemsWithHistory(
        (prev: CanvasItem[]) =>
          prev.map((current) =>
            current.id === item.id
              ? { ...current, scaleX: nextScaleX, x: nextX, y: nextY }
              : current
          ) as CanvasItem[]
      )
    },
    [setItemsWithHistory]
  )

  const handleCropImage = useCallback(
    (item: CanvasImageItem) => {
      setSelectedIds(new Set([item.id]))
      setContextMenuTarget(item)
      setExtractingImageId(null)
      setCroppingImageId(item.id)
      setTool('crop-select')
      actionMessageKeyRef.current = notifySuccess(
        '\u8bf7\u6846\u9009\u8981\u88c1\u5207\u7684\u533a\u57df\uff0c\u6309 Enter \u786e\u8ba4\uff0c\u6309 Esc \u53d6\u6d88',
        null
      )
    },
    [
      actionMessageKeyRef,
      notifySuccess,
      setContextMenuTarget,
      setCroppingImageId,
      setExtractingImageId,
      setSelectedIds,
      setTool
    ]
  )

  const handleExtractImage = useCallback(
    (item: CanvasImageItem) => {
      setSelectedIds(new Set([item.id]))
      setContextMenuTarget(item)
      setCroppingImageId(null)
      setExtractingImageId(item.id)
      setTool('extract-select')
      actionMessageKeyRef.current = notifySuccess(
        '\u8bf7\u6846\u9009\u8981\u63d0\u53d6\u7684\u533a\u57df\uff0c\u6309 Enter \u786e\u8ba4\uff0c\u6309 Esc \u7ed3\u675f\u63d0\u53d6',
        null
      )
    },
    [
      actionMessageKeyRef,
      notifySuccess,
      setContextMenuTarget,
      setCroppingImageId,
      setExtractingImageId,
      setSelectedIds,
      setTool
    ]
  )

  return {
    annotationFillEnabled,
    annotationToolbarBorderColor,
    annotationToolbarHoverSurface,
    annotationToolbarIdleSurface,
    annotationToolbarMutedText,
    annotationToolbarShadow,
    annotationToolbarStrongText,
    annotationToolbarSurface,
    buildCanvasDragPayload,
    countLabel,
    getCanvasImageDragObjectUrl,
    handleBringForward,
    handleBringToFront,
    handleCloseImageContextMenu,
    handleConfirmLabelDialog,
    handleCopyCanvasImage,
    handleCropImage,
    handleDownloadCanvasImage,
    handleExtractImage,
    handleFlipImage,
    handleImageContextMenu,
    handleOpenTextureImportFromContextMenu,
    handleSendBackward,
    handleSendToBack,
    handleSendToPhotoshop,
    handleSmartCleanup,
    handleToggleAnnotationFillMode,
    handleCopyCanvasItemsAsImage,
    handleDownloadCanvasItemsAsImage,
    handleSendCanvasItemsSnapshotToPhotoshop,
    hasSelectedTextItem,
    isLightCanvasTheme,
    resetDraggedItemNode,
    scalePercent,
    setCanvasDragPayload,
    showAnnotationFillToggle,
    showAnnotationStrokeControl,
    tryHandleCanvasExternalDrop
  }
}
