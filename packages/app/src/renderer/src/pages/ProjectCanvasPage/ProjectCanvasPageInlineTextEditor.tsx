import React from 'react'
import { createPortal } from 'react-dom'

import type { AttachedCaptionAnnotation } from './canvasAttachedCaptionUtils'
import {
  CANVAS_TEXT_LINE_HEIGHT,
  CANVAS_TEXT_PADDING,
  CANVAS_TEXT_WRAP,
  measureCanvasAnnotationTextHeight,
  measureCanvasTextBoxHeight
} from './canvasTextLayout'
import { buildCanvasSelectionOutlineStyles } from './components/projectCanvasInteractionOverlayStyles'
import type { CanvasTool } from './projectCanvasPageShared'
import type { CanvasItem, CanvasTextItem } from './types'

export type InlineTextEditState = {
  id: string
  x: number
  y: number
  w: number
  h: number
  text: string
  isNew: boolean
  fontSize?: number
  fontFamily?: string
  fontWeight?: 'normal' | 'bold'
  fill?: string
  attachedToId?: string
  attachmentPlacement?: 'bottom-center'
  attachmentBaseScale?: number
  attachmentBaseFontSize?: number
  attachmentBaseHeight?: number
  _createdAt?: number
}

type ProjectCanvasPageInlineTextEditorProps = {
  canvasContainerRef: React.RefObject<HTMLDivElement | null>
  canvasContainerElement?: HTMLDivElement | null
  inlineTextEdit: InlineTextEditState | null
  setInlineTextEdit: React.Dispatch<React.SetStateAction<InlineTextEditState | null>>
  inlineTextAreaRef: React.MutableRefObject<HTMLTextAreaElement | null>
  mediaCaptionPlaceholder: string
  stageScale: number
  stagePos: { x: number; y: number }
  annotationColor: string
  items: CanvasItem[]
  nextZIndexRef: React.MutableRefObject<number>
  setItemsWithHistory: React.Dispatch<React.SetStateAction<CanvasItem[]>>
  setSelectedIds: React.Dispatch<React.SetStateAction<Set<string>>>
  setTool: React.Dispatch<React.SetStateAction<CanvasTool>>
}

export default function ProjectCanvasPageInlineTextEditor({
  canvasContainerRef,
  canvasContainerElement,
  inlineTextEdit,
  setInlineTextEdit,
  inlineTextAreaRef,
  mediaCaptionPlaceholder,
  stageScale,
  stagePos,
  annotationColor,
  items,
  nextZIndexRef,
  setItemsWithHistory,
  setSelectedIds,
  setTool
}: ProjectCanvasPageInlineTextEditorProps) {
  if (!inlineTextEdit) {
    return null
  }

  const isTextItem = inlineTextEdit.id.startsWith('text-')
  const inlineTextFontFamily = inlineTextEdit.fontFamily || 'system-ui, sans-serif'
  const inlineTextFontWeight = inlineTextEdit.fontWeight === 'bold' ? 'bold' : 'normal'
  const inlineAnnotationEditorSelectionStyles = isTextItem
    ? {}
    : buildCanvasSelectionOutlineStyles(true)
  const portalHost = canvasContainerElement ?? canvasContainerRef.current

  const handleBlur = (event: React.FocusEvent<HTMLTextAreaElement>) => {
    const trimmedText = inlineTextEdit.text.trim()
    const actualWidth = event.target.offsetWidth / stageScale
    const actualHeight = event.target.offsetHeight / stageScale

    if (!trimmedText && inlineTextEdit.isNew) {
      const elapsed = inlineTextEdit._createdAt
        ? Date.now() - inlineTextEdit._createdAt
        : Number.POSITIVE_INFINITY
      if (elapsed < 500) {
        window.setTimeout(() => {
          const textarea = document.querySelector(
            'textarea[autofocus]'
          ) as HTMLTextAreaElement | null
          textarea?.focus()
        }, 10)
        return
      }

      setInlineTextEdit(null)
      return
    }

    if (trimmedText) {
      let bestFontSize = 16
      let finalWidth = actualWidth
      let finalHeight = actualHeight

      if (isTextItem) {
        const existing = items.find(
          (item): item is CanvasTextItem => item.id === inlineTextEdit.id && item.type === 'text'
        )
        bestFontSize = inlineTextEdit.fontSize ?? existing?.fontSize ?? 16
        finalHeight = measureCanvasTextBoxHeight({
          text: trimmedText,
          width: finalWidth,
          fontSize: bestFontSize,
          fontFamily: inlineTextEdit.fontFamily ?? existing?.fontFamily ?? 'system-ui, sans-serif',
          fontWeight: inlineTextEdit.fontWeight ?? existing?.fontWeight ?? 'normal',
          wrap: CANVAS_TEXT_WRAP,
          lineHeight: CANVAS_TEXT_LINE_HEIGHT
        })
      } else {
        finalWidth = Math.max(10, inlineTextEdit.w)
        finalHeight = Math.max(10, inlineTextEdit.h)
        bestFontSize = inlineTextEdit.fontSize || 36

        let minFontSize = 1
        let maxFontSize = Math.max(1, Math.floor(bestFontSize))
        let snappedFontSize = bestFontSize
        while (minFontSize <= maxFontSize) {
          const mid = Math.floor((minFontSize + maxFontSize) / 2)
          if (
            measureCanvasAnnotationTextHeight({
              text: trimmedText,
              width: finalWidth,
              fontSize: mid,
              fontWeight: inlineTextFontWeight
            }) <=
            finalHeight + 2
          ) {
            snappedFontSize = mid
            minFontSize = mid + 1
          } else {
            maxFontSize = mid - 1
          }
        }
        bestFontSize = snappedFontSize
      }

      const nextAttachmentBaseFontSize =
        inlineTextEdit.attachmentBaseFontSize && inlineTextEdit.fontSize
          ? Math.max(
              1,
              (inlineTextEdit.attachmentBaseFontSize * bestFontSize) / inlineTextEdit.fontSize
            )
          : inlineTextEdit.attachmentBaseFontSize
      const attachmentScaleBasisAttrs = inlineTextEdit.attachedToId
        ? {
            attachmentBaseScale: inlineTextEdit.attachmentBaseScale,
            attachmentBaseFontSize: nextAttachmentBaseFontSize,
            attachmentBaseHeight: inlineTextEdit.attachmentBaseHeight
          }
        : {}

      const newItem: AttachedCaptionAnnotation = {
        id: inlineTextEdit.id,
        type: 'annotation',
        shape: 'text-anno',
        x: inlineTextEdit.x,
        y: inlineTextEdit.y,
        width: finalWidth,
        height: finalHeight,
        rotation: 0,
        scaleX: 1,
        scaleY: 1,
        zIndex: nextZIndexRef.current++,
        locked: false,
        stroke: annotationColor,
        fillOpacity: 0,
        strokeWidth: 0,
        label: '',
        text: trimmedText,
        fontSize: bestFontSize,
        fontWeight: inlineTextEdit.fontWeight,
        attachedToId: inlineTextEdit.attachedToId,
        attachmentPlacement: inlineTextEdit.attachmentPlacement,
        ...attachmentScaleBasisAttrs
      }

      setItemsWithHistory((previousItems) => {
        const exists = previousItems.some((item) => item.id === inlineTextEdit.id)
        if (exists) {
          return previousItems.map((item) =>
            item.id === inlineTextEdit.id
              ? {
                  ...item,
                  text: trimmedText,
                  fontSize: bestFontSize,
                  width: finalWidth,
                  height: finalHeight,
                  scaleX: 1,
                  scaleY: 1,
                  ...attachmentScaleBasisAttrs
                }
              : item
          ) as CanvasItem[]
        }

        return [...previousItems, newItem]
      })
      setSelectedIds(new Set([inlineTextEdit.id]))
      setTool('select')
    } else if (!inlineTextEdit.isNew) {
      setItemsWithHistory((previousItems) =>
        previousItems.filter((item) => item.id !== inlineTextEdit.id)
      )
    }

    setInlineTextEdit(null)
  }

  const editor = (
    <textarea
      ref={inlineTextAreaRef}
      autoFocus
      aria-label={mediaCaptionPlaceholder}
      placeholder=""
      value={inlineTextEdit.text}
      onChange={(event) =>
        setInlineTextEdit((previous) =>
          previous ? { ...previous, text: event.target.value } : null
        )
      }
      onBlur={handleBlur}
      onKeyDown={(event) => {
        event.stopPropagation()
        if (event.key === 'Escape') {
          event.currentTarget.blur()
        }
      }}
      style={{
        position: 'absolute',
        left: stagePos.x + inlineTextEdit.x * stageScale,
        top: stagePos.y + inlineTextEdit.y * stageScale,
        width: Math.max(inlineTextEdit.w * stageScale, 10),
        height: Math.max(inlineTextEdit.h * stageScale, 10),
        fontSize: isTextItem
          ? (inlineTextEdit.fontSize || 16) * stageScale
          : (inlineTextEdit.fontSize || 36) * stageScale,
        fontFamily: isTextItem ? inlineTextFontFamily : 'system-ui, sans-serif',
        fontWeight: inlineTextFontWeight === 'bold' ? 700 : 400,
        color: isTextItem ? inlineTextEdit.fill || '#e0e0e0' : annotationColor,
        background: isTextItem ? 'rgba(30,30,30,0.85)' : 'transparent',
        border: 'none',
        borderRadius: isTextItem ? 6 : 0,
        boxSizing: 'border-box',
        outline: 'none',
        outlineOffset: 0,
        resize: 'none',
        overflow: 'hidden',
        pointerEvents: 'auto',
        padding: isTextItem ? `${CANVAS_TEXT_PADDING * stageScale}px` : '0px',
        lineHeight: isTextItem ? CANVAS_TEXT_LINE_HEIGHT : 1.0,
        textAlign: 'left',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-all',
        overflowWrap: isTextItem ? 'anywhere' : 'normal',
        caretColor: isTextItem ? inlineTextEdit.fill || '#e0e0e0' : annotationColor,
        boxShadow: 'none',
        ...inlineAnnotationEditorSelectionStyles,
        zIndex: 1000
      }}
    />
  )

  return portalHost ? createPortal(editor, portalHost) : editor
}
