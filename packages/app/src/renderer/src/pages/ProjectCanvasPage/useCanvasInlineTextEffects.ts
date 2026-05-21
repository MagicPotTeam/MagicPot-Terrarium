import { useEffect, type Dispatch, type RefObject, type SetStateAction } from 'react'

import {
  pruneOrphanAttachedCaptions,
  resolveCanvasItemAttachmentScale,
  resolveAttachedCaptionDraftLayout,
  resolveAttachedCaptionScaleBasis,
  type AttachedCaptionAnnotation
} from './canvasAttachedCaptionUtils'
import type { InlineTextEditState } from './ProjectCanvasPageInlineTextEditor'
import { INLINE_TEXT_EDIT_SCREEN_MARGIN } from './projectCanvasPageShared'
import type { CanvasItem } from './types'

export type CanvasItemVisualBounds = {
  x: number
  y: number
  width: number
  height: number
}

export type UseCanvasInlineTextEffectsOptions = {
  getCanvasItemVisualBounds: (item: CanvasItem) => CanvasItemVisualBounds | null | undefined
  inlineTextAreaRef: RefObject<HTMLTextAreaElement | null>
  inlineTextEdit: InlineTextEditState | null
  itemIdSet: ReadonlySet<string>
  items: CanvasItem[]
  setInlineTextEdit: Dispatch<SetStateAction<InlineTextEditState | null>>
  setItems: Dispatch<SetStateAction<CanvasItem[]>>
  setStagePos: Dispatch<SetStateAction<{ x: number; y: number }>>
  stagePos: { x: number; y: number }
  stageScale: number
  stageSize: { width: number; height: number }
}

type ResolveInlineTextViewportShiftOptions = {
  inlineTextEdit: InlineTextEditState
  stagePos: { x: number; y: number }
  stageScale: number
  stageSize: { width: number; height: number }
}

const ATTACHED_CAPTION_OFFSET_Y = 12
const TEXT_ITEM_MIN_EDITOR_WIDTH = 200
const TEXT_ITEM_MIN_EDITOR_HEIGHT = 60
const INLINE_TEXT_RESIZE_EPSILON = 2
const INLINE_TEXT_POSITION_EPSILON = 0.5
const INLINE_TEXT_SIZE_EPSILON = 0.5

export function getCanvasItemFallbackBounds(item: CanvasItem): CanvasItemVisualBounds {
  return {
    x: item.x,
    y: item.y,
    width: Math.max(1, item.width * Math.abs(item.scaleX || 1)),
    height: Math.max(1, item.height * Math.abs(item.scaleY || 1))
  }
}

export function resolveAttachedCaptionPosition(
  parentBounds: CanvasItemVisualBounds,
  captionWidth: number
): { x: number; y: number } {
  return {
    x: parentBounds.x + (parentBounds.width - captionWidth) / 2,
    y: parentBounds.y + parentBounds.height + ATTACHED_CAPTION_OFFSET_Y
  }
}

export function shouldClearInlineTextEdit(
  inlineTextEdit: InlineTextEditState | null,
  itemIdSet: ReadonlySet<string>
): boolean {
  if (!inlineTextEdit) return false
  if (inlineTextEdit.attachedToId && !itemIdSet.has(inlineTextEdit.attachedToId)) {
    return true
  }

  return !inlineTextEdit.isNew && !itemIdSet.has(inlineTextEdit.id)
}

export function shouldAutoFitInlineAnnotationEditorFont(
  inlineTextEdit: InlineTextEditState | null
): inlineTextEdit is InlineTextEditState {
  return Boolean(
    inlineTextEdit && inlineTextEdit.id.startsWith('anno-') && !inlineTextEdit.attachedToId
  )
}

export function resolveInlineTextViewportShift({
  inlineTextEdit,
  stagePos,
  stageScale,
  stageSize
}: ResolveInlineTextViewportShiftOptions): { x: number; y: number } | null {
  if (!inlineTextEdit.isNew) {
    return null
  }

  if (inlineTextEdit.attachedToId) {
    return null
  }

  const isTextItem = inlineTextEdit.id.startsWith('text-')
  const editorWidth = Math.max(
    inlineTextEdit.w * stageScale,
    isTextItem ? TEXT_ITEM_MIN_EDITOR_WIDTH : 10
  )
  const editorHeight = Math.max(
    inlineTextEdit.h * stageScale,
    isTextItem ? TEXT_ITEM_MIN_EDITOR_HEIGHT : 10
  )
  const left = stagePos.x + inlineTextEdit.x * stageScale
  const top = stagePos.y + inlineTextEdit.y * stageScale
  const right = left + editorWidth
  const bottom = top + editorHeight

  let nextStageX = stagePos.x
  let nextStageY = stagePos.y

  if (left < INLINE_TEXT_EDIT_SCREEN_MARGIN) {
    nextStageX += INLINE_TEXT_EDIT_SCREEN_MARGIN - left
  } else if (right > stageSize.width - INLINE_TEXT_EDIT_SCREEN_MARGIN) {
    nextStageX -= right - (stageSize.width - INLINE_TEXT_EDIT_SCREEN_MARGIN)
  }

  if (top < INLINE_TEXT_EDIT_SCREEN_MARGIN) {
    nextStageY += INLINE_TEXT_EDIT_SCREEN_MARGIN - top
  } else if (bottom > stageSize.height - INLINE_TEXT_EDIT_SCREEN_MARGIN) {
    nextStageY -= bottom - (stageSize.height - INLINE_TEXT_EDIT_SCREEN_MARGIN)
  }

  if (
    Math.abs(nextStageX - stagePos.x) <= INLINE_TEXT_POSITION_EPSILON &&
    Math.abs(nextStageY - stagePos.y) <= INLINE_TEXT_POSITION_EPSILON
  ) {
    return null
  }

  return { x: nextStageX, y: nextStageY }
}

export function useCanvasInlineTextEffects({
  getCanvasItemVisualBounds,
  inlineTextAreaRef,
  inlineTextEdit,
  itemIdSet,
  items,
  setInlineTextEdit,
  setItems,
  setStagePos,
  stagePos,
  stageScale,
  stageSize
}: UseCanvasInlineTextEffectsOptions) {
  const inlineTextEditId = inlineTextEdit?.id ?? null

  useEffect(() => {
    if (!inlineTextEditId) return

    const handle = window.requestAnimationFrame(() => {
      const element = inlineTextAreaRef.current
      if (!element) return
      element.focus()
      const cursor = element.value.length
      try {
        element.setSelectionRange(cursor, cursor)
      } catch {
        // Ignore selection errors for unsupported input states.
      }
    })

    return () => window.cancelAnimationFrame(handle)
  }, [inlineTextAreaRef, inlineTextEditId])

  useEffect(() => {
    if (!shouldAutoFitInlineAnnotationEditorFont(inlineTextEdit)) return

    const element = inlineTextAreaRef.current
    if (!element || !element.value) return

    const targetHeight = inlineTextEdit.h * stageScale
    if (element.scrollHeight <= targetHeight + 2) return

    const currentFontSize =
      parseFloat(element.style.fontSize) || (inlineTextEdit.fontSize || 36) * stageScale
    let minFont = 1
    let maxFont = currentFontSize
    let bestFont = minFont

    while (minFont <= maxFont) {
      const mid = Math.floor((minFont + maxFont) / 2)
      element.style.fontSize = `${mid}px`
      if (element.scrollHeight <= targetHeight + 2) {
        bestFont = mid
        minFont = mid + 1
      } else {
        maxFont = mid - 1
      }
    }

    element.style.fontSize = `${bestFont}px`

    const newBaseFont = bestFont / stageScale
    if (Math.abs((inlineTextEdit.fontSize || 0) - newBaseFont) > INLINE_TEXT_POSITION_EPSILON) {
      setInlineTextEdit((previous) =>
        previous ? { ...previous, fontSize: newBaseFont } : previous
      )
    }
  }, [inlineTextAreaRef, inlineTextEdit, setInlineTextEdit, stageScale])

  useEffect(() => {
    const element = inlineTextAreaRef.current
    if (!element || !inlineTextEditId || inlineTextEditId.startsWith('text-')) return
    if (inlineTextEdit?.attachedToId) return
    if (typeof ResizeObserver === 'undefined') return

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.target !== element) continue

        const newWidth = element.offsetWidth / stageScale
        const newHeight = element.offsetHeight / stageScale
        setInlineTextEdit((previous) => {
          if (!previous) return previous
          if (
            Math.abs(previous.w - newWidth) > INLINE_TEXT_RESIZE_EPSILON ||
            Math.abs(previous.h - newHeight) > INLINE_TEXT_RESIZE_EPSILON
          ) {
            return { ...previous, w: newWidth, h: newHeight }
          }

          return previous
        })
      }
    })

    observer.observe(element)
    return () => observer.disconnect()
  }, [
    inlineTextAreaRef,
    inlineTextEdit?.attachedToId,
    inlineTextEditId,
    setInlineTextEdit,
    stageScale
  ])

  useEffect(() => {
    if (!inlineTextEdit) return

    const nextStagePos = resolveInlineTextViewportShift({
      inlineTextEdit,
      stagePos,
      stageScale,
      stageSize
    })
    if (nextStagePos) {
      setStagePos(nextStagePos)
    }
  }, [inlineTextEdit, setStagePos, stagePos, stageScale, stageSize])

  useEffect(() => {
    setItems((previousItems) => {
      const baseItems = pruneOrphanAttachedCaptions(previousItems)
      let changed = baseItems !== previousItems

      const nextItems = baseItems.map((item) => {
        const attachedAnnotation = item as AttachedCaptionAnnotation
        if (
          attachedAnnotation.type !== 'annotation' ||
          attachedAnnotation.shape !== 'text-anno' ||
          !attachedAnnotation.attachedToId ||
          attachedAnnotation.attachmentPlacement !== 'bottom-center'
        ) {
          return item
        }

        const parentItem = baseItems.find(
          (candidate) => candidate.id === attachedAnnotation.attachedToId
        )
        if (!parentItem) return item

        const parentBounds =
          getCanvasItemVisualBounds(parentItem) ?? getCanvasItemFallbackBounds(parentItem)
        const parentScale = resolveCanvasItemAttachmentScale(parentItem)
        const scaleBasis = resolveAttachedCaptionScaleBasis(parentScale, attachedAnnotation)
        const nextLayout = resolveAttachedCaptionDraftLayout(parentBounds, {
          parentScale,
          baseScale: scaleBasis.baseScale,
          baseFontSize: scaleBasis.baseFontSize,
          baseHeight: scaleBasis.baseHeight
        })

        if (
          Math.abs(attachedAnnotation.x - nextLayout.x) < INLINE_TEXT_POSITION_EPSILON &&
          Math.abs(attachedAnnotation.y - nextLayout.y) < INLINE_TEXT_POSITION_EPSILON &&
          Math.abs(attachedAnnotation.width - nextLayout.width) < INLINE_TEXT_SIZE_EPSILON &&
          Math.abs(attachedAnnotation.height - nextLayout.height) < INLINE_TEXT_SIZE_EPSILON &&
          Math.abs((attachedAnnotation.fontSize || 0) - nextLayout.fontSize) <
            INLINE_TEXT_SIZE_EPSILON &&
          Math.abs((attachedAnnotation.attachmentBaseScale || 0) - scaleBasis.baseScale) <
            INLINE_TEXT_SIZE_EPSILON &&
          Math.abs((attachedAnnotation.attachmentBaseFontSize || 0) - scaleBasis.baseFontSize) <
            INLINE_TEXT_SIZE_EPSILON &&
          Math.abs((attachedAnnotation.attachmentBaseHeight || 0) - scaleBasis.baseHeight) <
            INLINE_TEXT_SIZE_EPSILON
        ) {
          return item
        }

        changed = true
        return {
          ...attachedAnnotation,
          x: nextLayout.x,
          y: nextLayout.y,
          width: nextLayout.width,
          height: nextLayout.height,
          fontSize: nextLayout.fontSize,
          attachmentBaseScale: scaleBasis.baseScale,
          attachmentBaseFontSize: scaleBasis.baseFontSize,
          attachmentBaseHeight: scaleBasis.baseHeight
        }
      })

      return changed ? nextItems : previousItems
    })
  }, [getCanvasItemVisualBounds, items, setItems])

  useEffect(() => {
    if (shouldClearInlineTextEdit(inlineTextEdit, itemIdSet)) {
      setInlineTextEdit(null)
    }
  }, [inlineTextEdit, itemIdSet, setInlineTextEdit])

  useEffect(() => {
    if (!inlineTextEdit?.attachedToId || inlineTextEdit.attachmentPlacement !== 'bottom-center') {
      return
    }

    const parentItem = items.find((item) => item.id === inlineTextEdit.attachedToId)
    if (!parentItem) return

    const parentBounds =
      getCanvasItemVisualBounds(parentItem) ?? getCanvasItemFallbackBounds(parentItem)
    const parentScale = resolveCanvasItemAttachmentScale(parentItem)
    const scaleBasis = resolveAttachedCaptionScaleBasis(parentScale, {
      fontSize: inlineTextEdit.fontSize,
      height: inlineTextEdit.h,
      attachmentBaseScale: inlineTextEdit.attachmentBaseScale,
      attachmentBaseFontSize: inlineTextEdit.attachmentBaseFontSize,
      attachmentBaseHeight: inlineTextEdit.attachmentBaseHeight
    })
    const nextLayout = resolveAttachedCaptionDraftLayout(parentBounds, {
      parentScale,
      baseScale: scaleBasis.baseScale,
      baseFontSize: scaleBasis.baseFontSize,
      baseHeight: scaleBasis.baseHeight
    })

    if (
      Math.abs(inlineTextEdit.x - nextLayout.x) < INLINE_TEXT_POSITION_EPSILON &&
      Math.abs(inlineTextEdit.y - nextLayout.y) < INLINE_TEXT_POSITION_EPSILON &&
      Math.abs(inlineTextEdit.w - nextLayout.width) < INLINE_TEXT_SIZE_EPSILON &&
      Math.abs(inlineTextEdit.h - nextLayout.height) < INLINE_TEXT_SIZE_EPSILON &&
      Math.abs((inlineTextEdit.fontSize || 0) - nextLayout.fontSize) < INLINE_TEXT_SIZE_EPSILON &&
      Math.abs((inlineTextEdit.attachmentBaseScale || 0) - scaleBasis.baseScale) <
        INLINE_TEXT_SIZE_EPSILON &&
      Math.abs((inlineTextEdit.attachmentBaseFontSize || 0) - scaleBasis.baseFontSize) <
        INLINE_TEXT_SIZE_EPSILON &&
      Math.abs((inlineTextEdit.attachmentBaseHeight || 0) - scaleBasis.baseHeight) <
        INLINE_TEXT_SIZE_EPSILON
    ) {
      return
    }

    setInlineTextEdit((previous) =>
      previous && previous.attachedToId === parentItem.id
        ? {
            ...previous,
            x: nextLayout.x,
            y: nextLayout.y,
            w: nextLayout.width,
            h: nextLayout.height,
            fontSize: nextLayout.fontSize,
            attachmentBaseScale: scaleBasis.baseScale,
            attachmentBaseFontSize: scaleBasis.baseFontSize,
            attachmentBaseHeight: scaleBasis.baseHeight
          }
        : previous
    )
  }, [getCanvasItemVisualBounds, inlineTextEdit, items, setInlineTextEdit])
}
