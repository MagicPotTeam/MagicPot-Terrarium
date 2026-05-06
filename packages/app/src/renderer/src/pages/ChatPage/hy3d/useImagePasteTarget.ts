import React from 'react'
import {
  activateQuickAppImagePasteTarget,
  deactivateQuickAppImagePasteTarget
} from '@renderer/utils/quickAppPasteTarget'

type PasteTargetId = string

type ImagePasteTargetProps = Pick<
  React.HTMLAttributes<HTMLElement>,
  'onMouseEnter' | 'onMouseLeave' | 'onFocus' | 'onBlur'
> & {
  tabIndex: number
}

interface UseImagePasteTargetOptions {
  onPasteImage: (targetId: PasteTargetId, file: File) => void | Promise<void>
}

const buildPastedImageFile = (blob: File): File => {
  const rawExtension = blob.type.split('/')[1] || 'png'
  const extension = rawExtension === 'jpeg' ? 'jpg' : rawExtension

  return new File([blob], `pasted-image-${Date.now()}.${extension}`, {
    type: blob.type
  })
}

export const useImagePasteTarget = ({ onPasteImage }: UseImagePasteTargetOptions) => {
  const [hoveredTargetId, setHoveredTargetId] = React.useState<PasteTargetId | null>(null)
  const [focusedTargetId, setFocusedTargetId] = React.useState<PasteTargetId | null>(null)
  const pasteTargetTokenRef = React.useRef(Symbol('hy3d-image-paste-target'))

  const activeTargetId = hoveredTargetId || focusedTargetId

  const clearHoveredTarget = React.useCallback((targetId: PasteTargetId) => {
    setHoveredTargetId((current) => (current === targetId ? null : current))
  }, [])

  const clearFocusedTarget = React.useCallback((targetId: PasteTargetId) => {
    setFocusedTargetId((current) => (current === targetId ? null : current))
  }, [])

  const getPasteTargetProps = React.useCallback(
    (targetId: PasteTargetId, options?: { disabled?: boolean }): Partial<ImagePasteTargetProps> => {
      if (options?.disabled) {
        return {}
      }

      return {
        tabIndex: 0,
        onMouseEnter: () => setHoveredTargetId(targetId),
        onMouseLeave: () => clearHoveredTarget(targetId),
        onFocus: () => setFocusedTargetId(targetId),
        onBlur: () => clearFocusedTarget(targetId)
      }
    },
    [clearFocusedTarget, clearHoveredTarget]
  )

  const isPasteTargetActive = React.useCallback(
    (targetId: PasteTargetId) => hoveredTargetId === targetId || focusedTargetId === targetId,
    [focusedTargetId, hoveredTargetId]
  )

  const handlePaste = React.useCallback(
    (event: ClipboardEvent) => {
      if (!activeTargetId) return

      const items = event.clipboardData?.items
      if (!items) return

      for (let i = 0; i < items.length; i++) {
        const item = items[i]
        if (!item.type.includes('image')) continue

        event.preventDefault()
        event.stopImmediatePropagation()

        const blob = item.getAsFile()
        if (blob) {
          void onPasteImage(activeTargetId, buildPastedImageFile(blob))
        }
        break
      }
    },
    [activeTargetId, onPasteImage]
  )

  React.useEffect(() => {
    const token = pasteTargetTokenRef.current

    if (activeTargetId) {
      activateQuickAppImagePasteTarget(token)
    } else {
      deactivateQuickAppImagePasteTarget(token)
    }

    return () => {
      deactivateQuickAppImagePasteTarget(token)
    }
  }, [activeTargetId])

  React.useEffect(() => {
    document.addEventListener('paste', handlePaste)
    return () => {
      document.removeEventListener('paste', handlePaste)
    }
  }, [handlePaste])

  return {
    activeTargetId,
    getPasteTargetProps,
    isPasteTargetActive
  }
}
