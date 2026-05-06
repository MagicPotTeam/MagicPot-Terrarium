import { useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import { api } from '../../utils/windowUtils'
import { removeCanvasItemsWithAttachedCaptions } from './canvasAttachedCaptionUtils'
import type { CanvasTool, ExportImageFormat, ExportMenuScope } from './projectCanvasPageShared'
import type { SelectionRect } from './useCanvasTargetWorkflow'
import type {
  AnnotationShape,
  CanvasAnnotationItem,
  CanvasImageItem,
  CanvasItem,
  CanvasTextItem
} from './types'

type UseCanvasKeyboardShortcutsOptions = {
  canvasActiveRef: MutableRefObject<boolean>
  toolShortcuts: Record<string, string>
  handleSaveCanvas: () => Promise<void> | void
  handleSaveCanvasAs: () => Promise<void> | void
  handleExportScopeWithFormat: (scope: ExportMenuScope, format: ExportImageFormat) => void
  handleUndo: () => void
  handleRedo: () => void
  items: CanvasItem[]
  selectedIds: Set<string>
  setSelectedIds: Dispatch<SetStateAction<Set<string>>>
  setItemsWithHistory: Dispatch<SetStateAction<CanvasItem[]>>
  setTool: Dispatch<SetStateAction<CanvasTool>>
  setAnnoTool: Dispatch<SetStateAction<AnnotationShape>>
  setSelectionRect: Dispatch<SetStateAction<SelectionRect>>
  setCroppingImageId: Dispatch<SetStateAction<string | null>>
  setExtractingImageId: Dispatch<SetStateAction<string | null>>
}

function toShortcutKey(key: string): string {
  return key === ' ' ? 'Space' : key.length === 1 ? key.toUpperCase() : key
}

function eventMatchesShortcutKey(event: KeyboardEvent, targetKey: string): boolean {
  if (!targetKey) return false

  const normalizedEventKey = toShortcutKey(event.key)
  if (normalizedEventKey === targetKey) {
    return true
  }

  if (targetKey.length === 1 && /^[A-Z]$/.test(targetKey)) {
    return event.code === `Key${targetKey}`
  }

  if (targetKey.length === 1 && /^[0-9]$/.test(targetKey)) {
    return event.code === `Digit${targetKey}`
  }

  if (targetKey === 'Space') {
    return event.code === 'Space'
  }

  if (targetKey === '-') {
    return event.code === 'Minus'
  }

  return false
}

function matchesShortcut(event: KeyboardEvent, combo: string): boolean {
  const parts = combo.split('+')
  const needCtrl = parts.includes('Ctrl')
  const needAlt = parts.includes('Alt')
  const needShift = parts.includes('Shift')
  const targetKey = parts.filter((part) => !['Ctrl', 'Alt', 'Shift'].includes(part))[0] || ''

  return (
    (!needCtrl || event.ctrlKey || event.metaKey) &&
    (needCtrl || (!event.ctrlKey && !event.metaKey)) &&
    (!needAlt || event.altKey) &&
    (needAlt || !event.altKey) &&
    (!needShift || event.shiftKey) &&
    (needShift || !event.shiftKey) &&
    eventMatchesShortcutKey(event, targetKey)
  )
}

function isInputTarget(target: Element | null): boolean {
  if (!target) return false
  return (
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    (target as HTMLElement).isContentEditable
  )
}

function hasDocumentTextSelection(): boolean {
  const selection = window.getSelection?.()
  return Boolean(selection && !selection.isCollapsed && selection.toString().trim())
}

function isDeleteKey(event: KeyboardEvent): boolean {
  return event.key === 'Delete' || event.key === 'Del' || event.code === 'Delete'
}

function decodeLocalCanvasImagePath(url: string): string | null {
  if (url.startsWith('local-media:///')) {
    return decodeURIComponent(url.slice('local-media:///'.length))
  }

  if (url.startsWith('local-media://')) {
    return decodeURIComponent(url.slice('local-media://'.length).replace(/^\/+/, ''))
  }

  if (url.startsWith('file:///')) {
    return decodeURIComponent(url.slice('file:///'.length))
  }

  if (url.startsWith('file://')) {
    return decodeURIComponent(url.slice('file://'.length).replace(/^\/+/, ''))
  }

  return null
}

function isSvgCanvasImage(item: CanvasImageItem): boolean {
  const normalizedFileName = item.fileName?.trim().toLowerCase() || ''
  if (normalizedFileName.endsWith('.svg')) {
    return true
  }

  const normalizedLocalPath = decodeLocalCanvasImagePath(item.src)?.toLowerCase() || ''
  if (normalizedLocalPath.endsWith('.svg')) {
    return true
  }

  return item.provenance?.kind === 'svg' || item.src.toLowerCase().startsWith('data:image/svg+xml')
}

async function readClipboardImageBytes(item: CanvasImageItem): Promise<Uint8Array> {
  const localPath = decodeLocalCanvasImagePath(item.src)
  if (localPath) {
    const { image } = await api().svcFs.readImageFromPath({ fullPath: localPath })
    return image
  }

  const response = await fetch(item.src)
  return new Uint8Array(await response.arrayBuffer())
}

async function readClipboardSvgMarkup(item: CanvasImageItem): Promise<string> {
  const localPath = decodeLocalCanvasImagePath(item.src)
  if (localPath) {
    const { data } = await api().svcFs.readFileFromPath({ fullPath: localPath })
    return new TextDecoder('utf-8').decode(data)
  }

  const response = await fetch(item.src)
  return await response.text()
}

async function copyImageToClipboard(item: CanvasImageItem) {
  try {
    if (isSvgCanvasImage(item)) {
      const svg = await readClipboardSvgMarkup(item)
      if (svg.trim()) {
        const svgResult = await api().svcHyper.writeSvgToClipboard({ svg })
        if (svgResult.success) {
          console.log('[Canvas] SVG copied to clipboard')
          return
        }

        console.error('[Canvas] Failed to copy SVG to clipboard')
      }
    }

    const data = await readClipboardImageBytes(item)
    const res = await api().svcHyper.writeImageToClipboard({ data })

    if (res.success) {
      console.log('[Canvas] Image copied to clipboard')
    } else {
      console.error('[Canvas] Failed to copy image to clipboard')
    }
  } catch (error) {
    console.error('[Canvas] Failed to copy image to clipboard', error)
  }
}

export function useCanvasKeyboardShortcuts({
  canvasActiveRef,
  toolShortcuts,
  handleSaveCanvas,
  handleSaveCanvasAs,
  handleExportScopeWithFormat,
  handleUndo,
  handleRedo,
  items,
  selectedIds,
  setSelectedIds,
  setItemsWithHistory,
  setTool,
  setAnnoTool,
  setSelectionRect,
  setCroppingImageId,
  setExtractingImageId
}: UseCanvasKeyboardShortcutsOptions) {
  const latestRef = useRef({
    toolShortcuts,
    handleSaveCanvas,
    handleSaveCanvasAs,
    handleExportScopeWithFormat,
    handleUndo,
    handleRedo,
    items,
    selectedIds,
    setSelectedIds,
    setItemsWithHistory,
    setTool,
    setAnnoTool,
    setSelectionRect,
    setCroppingImageId,
    setExtractingImageId
  })

  latestRef.current = {
    toolShortcuts,
    handleSaveCanvas,
    handleSaveCanvasAs,
    handleExportScopeWithFormat,
    handleUndo,
    handleRedo,
    items,
    selectedIds,
    setSelectedIds,
    setItemsWithHistory,
    setTool,
    setAnnoTool,
    setSelectionRect,
    setCroppingImageId,
    setExtractingImageId
  }

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const {
        toolShortcuts: latestToolShortcuts,
        handleSaveCanvas: latestHandleSaveCanvas,
        handleSaveCanvasAs: latestHandleSaveCanvasAs,
        handleExportScopeWithFormat: latestHandleExportScopeWithFormat,
        handleUndo: latestHandleUndo,
        handleRedo: latestHandleRedo,
        items: latestItems,
        selectedIds: latestSelectedIds,
        setSelectedIds: latestSetSelectedIds,
        setItemsWithHistory: latestSetItemsWithHistory,
        setTool: latestSetTool,
        setAnnoTool: latestSetAnnoTool,
        setSelectionRect: latestSetSelectionRect,
        setCroppingImageId: latestSetCroppingImageId,
        setExtractingImageId: latestSetExtractingImageId
      } = latestRef.current

      const active = document.activeElement
      const isInInput = isInputTarget(active)

      if (matchesShortcut(event, latestToolShortcuts.export)) {
        if (isInInput) return
        event.preventDefault()
        void latestHandleSaveCanvas()
        return
      }

      if (
        (event.ctrlKey || event.metaKey) &&
        event.shiftKey &&
        eventMatchesShortcutKey(event, 'S')
      ) {
        if (isInInput) return
        event.preventDefault()
        void latestHandleSaveCanvasAs()
        return
      }

      if (
        (event.ctrlKey || event.metaKey) &&
        !event.shiftKey &&
        !event.altKey &&
        eventMatchesShortcutKey(event, 'E')
      ) {
        if (isInInput) return
        event.preventDefault()
        latestHandleExportScopeWithFormat('scene', 'png')
        return
      }

      if (
        (event.ctrlKey || event.metaKey) &&
        event.shiftKey &&
        !event.altKey &&
        eventMatchesShortcutKey(event, 'E')
      ) {
        if (isInInput) return
        event.preventDefault()
        latestHandleExportScopeWithFormat('selected-scene', 'png')
        return
      }

      if (
        (event.ctrlKey || event.metaKey) &&
        event.altKey &&
        !event.shiftKey &&
        eventMatchesShortcutKey(event, 'I')
      ) {
        if (isInInput) return
        event.preventDefault()
        latestHandleExportScopeWithFormat('all-elements', 'png')
        return
      }

      if (
        (event.ctrlKey || event.metaKey) &&
        event.shiftKey &&
        !event.altKey &&
        eventMatchesShortcutKey(event, 'I')
      ) {
        if (isInInput) return
        event.preventDefault()
        latestHandleExportScopeWithFormat('selected-elements', 'png')
        return
      }

      if (
        (event.ctrlKey || event.metaKey) &&
        eventMatchesShortcutKey(event, 'Z') &&
        !event.shiftKey
      ) {
        if (isInInput) return
        event.preventDefault()
        latestHandleUndo()
        return
      }

      if (
        (event.ctrlKey || event.metaKey) &&
        (eventMatchesShortcutKey(event, 'Y') ||
          (eventMatchesShortcutKey(event, 'Z') && event.shiftKey))
      ) {
        if (isInInput) return
        event.preventDefault()
        latestHandleRedo()
        return
      }

      if ((event.ctrlKey || event.metaKey) && eventMatchesShortcutKey(event, 'A')) {
        if (isInInput) return
        event.preventDefault()
        latestSetSelectedIds(new Set(latestItems.map((item) => item.id)))
        return
      }

      if (
        (event.ctrlKey || event.metaKey) &&
        eventMatchesShortcutKey(event, 'C') &&
        latestSelectedIds.size > 0
      ) {
        if (isInInput) return
        if (hasDocumentTextSelection()) return
        event.preventDefault()

        const selectedText = latestItems.find(
          (item) =>
            latestSelectedIds.has(item.id) &&
            (item.type === 'text' || (item.type === 'annotation' && item.shape === 'text-anno'))
        ) as CanvasTextItem | CanvasAnnotationItem | undefined

        if (selectedText?.text) {
          navigator.clipboard
            .writeText(selectedText.text)
            .then(() => {
              console.log('[Canvas] Text copied to clipboard')
            })
            .catch((error) => {
              console.error('[Canvas] Failed to copy text to clipboard', error)
            })
          return
        }

        const selectedImage = latestItems.find(
          (item) => latestSelectedIds.has(item.id) && item.type === 'image'
        ) as CanvasImageItem | undefined

        if (selectedImage?.src) {
          void copyImageToClipboard(selectedImage)
        }
        return
      }

      if ((isDeleteKey(event) || event.key === 'Backspace') && latestSelectedIds.size > 0) {
        if (event.key === 'Backspace' && isInInput) return

        event.preventDefault()

        latestSetItemsWithHistory((prev) => {
          const { deletedIds, nextItems } = removeCanvasItemsWithAttachedCaptions(
            prev,
            latestSelectedIds
          )
          for (const item of prev) {
            if (
              deletedIds.has(item.id) &&
              (item.type === 'model3d' || item.type === 'video' || item.type === 'file')
            ) {
              URL.revokeObjectURL(item.src)
            }
          }
          return nextItems
        })
        latestSetSelectedIds(new Set())
        return
      }

      if (!canvasActiveRef.current) return

      if (isInInput) return

      if (matchesShortcut(event, latestToolShortcuts.select)) {
        latestSetTool('select')
        return
      }

      if (matchesShortcut(event, latestToolShortcuts.hand) && !event.repeat) {
        event.preventDefault()
        latestSetTool('hand')
        return
      }

      if (matchesShortcut(event, latestToolShortcuts.freedraw)) {
        latestSetTool('annotate')
        latestSetAnnoTool('freedraw')
        return
      }

      if (matchesShortcut(event, latestToolShortcuts.rect)) {
        latestSetTool('annotate')
        latestSetAnnoTool('rect')
        return
      }

      if (matchesShortcut(event, latestToolShortcuts.arrow)) {
        latestSetTool('annotate')
        latestSetAnnoTool('arrow')
        return
      }

      if (matchesShortcut(event, latestToolShortcuts.text)) {
        latestSetTool('annotate')
        latestSetAnnoTool('text-anno')
        return
      }

      if (event.key === 'Escape') {
        latestSetTool('select')
        latestSetSelectedIds(new Set())
        latestSetSelectionRect(null)
        latestSetCroppingImageId(null)
        latestSetExtractingImageId(null)
      }
    }

    const handleKeyUp = (event: KeyboardEvent) => {
      const { toolShortcuts: latestToolShortcuts, setTool: latestSetTool } = latestRef.current

      if (!canvasActiveRef.current) return

      const handParts = latestToolShortcuts.hand.split('+')
      const handKey = handParts.filter((part) => !['Ctrl', 'Alt', 'Shift'].includes(part))[0] || ''

      if (toShortcutKey(event.key) === handKey) {
        latestSetTool('select')
      }
    }

    window.addEventListener('keydown', handleKeyDown, true)
    window.addEventListener('keyup', handleKeyUp, true)

    return () => {
      window.removeEventListener('keydown', handleKeyDown, true)
      window.removeEventListener('keyup', handleKeyUp, true)
    }
  }, [canvasActiveRef])
}
