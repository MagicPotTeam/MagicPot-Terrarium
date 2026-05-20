import { useCallback, type Dispatch, type SetStateAction } from 'react'
import { useTranslation } from 'react-i18next'
import { useCanvasMediaActions } from './useCanvasMediaActions'
import {
  resolveCanvasItemAttachmentScale,
  resolveAttachedCaptionDraftLayout,
  type AttachedCaptionAnnotation
} from './canvasAttachedCaptionUtils'
import type { InlineTextEditState } from './ProjectCanvasPageInlineTextEditor'
import type { CanvasExportBounds } from './groupPlaybackUtils'
import type { CanvasTool, SendCanvasItemsToAgentOptions } from './projectCanvasPageShared'
import type { CanvasImageItem, CanvasItem, CanvasModel3DItem, CanvasVideoItem } from './types'

type NotifyFn = (message: string) => unknown

type MediaCaptionTargetItem = CanvasImageItem | CanvasVideoItem | CanvasModel3DItem

type SendCanvasItemsToAgentFn = (
  targetItems: CanvasItem[],
  targetScopeOrOptions?: string | SendCanvasItemsToAgentOptions
) => Promise<void> | void

type UseCanvasSelectionActionsOptions = {
  items: CanvasItem[]
  selectedIds: Set<string>
  setSelectedIds: Dispatch<SetStateAction<Set<string>>>
  setTool: Dispatch<SetStateAction<CanvasTool>>
  setInlineTextEdit: Dispatch<SetStateAction<InlineTextEditState | null>>
  getCanvasItemVisualBounds: (item: CanvasItem) => CanvasExportBounds | null
  handleSendCanvasItemsToAgent: SendCanvasItemsToAgentFn
  notifySuccess: NotifyFn
  notifyError: NotifyFn
  renderCanvasItemsImageBytes: (
    targetItems: CanvasItem[],
    format: 'png' | 'jpeg' | 'svg',
    includeBackground?: boolean
  ) => Promise<Uint8Array>
}

export function useCanvasSelectionActions({
  items,
  selectedIds,
  setSelectedIds,
  setTool,
  setInlineTextEdit,
  getCanvasItemVisualBounds,
  handleSendCanvasItemsToAgent,
  notifySuccess,
  notifyError,
  renderCanvasItemsImageBytes
}: UseCanvasSelectionActionsOptions) {
  const { t } = useTranslation()
  const { handleCopyCanvasItemsAsImage, handleDownloadCanvasItemsAsImage, handleDownloadBlobItem } =
    useCanvasMediaActions({
      notifySuccess,
      notifyError,
      renderCanvasItemsImageBytes
    })

  const handleSendCanvasItemsToAgentForGeneration = useCallback(
    async (targetItems: CanvasItem[], options?: SendCanvasItemsToAgentOptions) => {
      await handleSendCanvasItemsToAgent(targetItems, options)
    },
    [handleSendCanvasItemsToAgent]
  )

  const handleSendSelectionToAgent = useCallback(
    async (targetScope?: string) => {
      if (selectedIds.size === 0) return

      await handleSendCanvasItemsToAgent(
        items.filter((item) => selectedIds.has(item.id)),
        targetScope
      )
    },
    [handleSendCanvasItemsToAgent, items, selectedIds]
  )

  const handleOpenMediaCaptionEditor = useCallback(
    (targetItem: MediaCaptionTargetItem) => {
      const existingCaption = items.find(
        (item): item is AttachedCaptionAnnotation =>
          item.type === 'annotation' &&
          item.shape === 'text-anno' &&
          (item as AttachedCaptionAnnotation).attachedToId === targetItem.id
      )

      if (existingCaption) {
        setSelectedIds(new Set())
        setTool('select')
        setInlineTextEdit({
          id: existingCaption.id,
          x: existingCaption.x,
          y: existingCaption.y,
          w: Math.max(existingCaption.width * Math.abs(existingCaption.scaleX || 1), 120),
          h: Math.max(existingCaption.height * Math.abs(existingCaption.scaleY || 1), 36),
          text: existingCaption.text || '',
          isNew: false,
          fontSize: existingCaption.fontSize || 28,
          attachedToId: existingCaption.attachedToId,
          attachmentPlacement: existingCaption.attachmentPlacement || 'bottom-center',
          attachmentBaseScale: existingCaption.attachmentBaseScale,
          attachmentBaseFontSize: existingCaption.attachmentBaseFontSize,
          attachmentBaseHeight: existingCaption.attachmentBaseHeight
        })
        return
      }

      const targetBounds = getCanvasItemVisualBounds(targetItem) ?? {
        x: targetItem.x,
        y: targetItem.y,
        width: Math.max(1, targetItem.width * Math.abs(targetItem.scaleX || 1)),
        height: Math.max(1, targetItem.height * Math.abs(targetItem.scaleY || 1))
      }
      const attachmentBaseScale = resolveCanvasItemAttachmentScale(targetItem)
      const captionLayout = resolveAttachedCaptionDraftLayout(targetBounds, {
        parentScale: attachmentBaseScale,
        baseScale: attachmentBaseScale
      })

      setTool('select')
      setSelectedIds(new Set())
      setInlineTextEdit({
        id: `anno-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        x: captionLayout.x,
        y: captionLayout.y,
        w: captionLayout.width,
        h: captionLayout.height,
        text: '',
        isNew: true,
        fontSize: captionLayout.fontSize,
        attachedToId: targetItem.id,
        attachmentPlacement: 'bottom-center',
        attachmentBaseScale,
        attachmentBaseFontSize: captionLayout.fontSize,
        attachmentBaseHeight: captionLayout.height,
        _createdAt: Date.now()
      })
    },
    [getCanvasItemVisualBounds, items, setInlineTextEdit, setSelectedIds, setTool]
  )

  const mediaCaptionActionLabel =
    t('canvas.action_add_caption') === 'canvas.action_add_caption'
      ? 'Add caption'
      : t('canvas.action_add_caption')
  const mediaCaptionPlaceholder =
    t('canvas.media_caption_placeholder') === 'canvas.media_caption_placeholder'
      ? 'Add a caption'
      : t('canvas.media_caption_placeholder')

  return {
    handleCopyCanvasItemsAsImage,
    handleDownloadBlobItem,
    handleDownloadCanvasItemsAsImage,
    handleOpenMediaCaptionEditor,
    handleSendCanvasItemsToAgentForGeneration,
    handleSendSelectionToAgent,
    mediaCaptionActionLabel,
    mediaCaptionPlaceholder
  }
}
