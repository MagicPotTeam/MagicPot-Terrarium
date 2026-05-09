import React from 'react'
import { Box, IconButton, Tooltip, Typography } from '@mui/material'
import { DeleteOutline, UploadOutlined } from '@mui/icons-material'
import { useTranslation } from 'react-i18next'
import { useMessage } from '@renderer/hooks/useMessage'
import {
  getDroppedImageDropError,
  getDroppedImageFile,
  parseInternalImageDragPayload,
  UNSUPPORTED_INTERNAL_FILE_DROP_MESSAGE
} from '@renderer/utils/droppedImageUtils'
import {
  activateQuickAppImagePasteTarget,
  deactivateQuickAppImagePasteTarget
} from '@renderer/utils/quickAppPasteTarget'

type BaseInputComfyImageProps = {
  label: string
  Icon?: React.ComponentType<{ sx: { mr: number; color: string } }>
  internalValue: string
  isLoading: boolean
  previewUrl: string | null
  doUpload: (file: File) => Promise<void>
  placeholder: string
  buttonSlot?: React.ReactNode
  onClear?: () => void
}

const isPasteShortcut = (
  event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>
) =>
  (event.ctrlKey || event.metaKey) &&
  !event.altKey &&
  !event.shiftKey &&
  event.key.toLowerCase() === 'v'

const buildPastedImageFile = (blob: Blob, index = 0): File => {
  const timestamp = Date.now()
  const extension = blob.type.split('/')[1]?.split('+')[0]?.trim() || 'png'
  return new File([blob], `pasted-image-${timestamp}-${index + 1}.${extension}`, {
    type: blob.type
  })
}

const BaseInputComfyImage: React.FC<BaseInputComfyImageProps> = ({
  label,
  internalValue,
  isLoading,
  previewUrl,
  placeholder,
  Icon,
  buttonSlot,
  onClear,
  doUpload
}) => {
  const { t } = useTranslation()
  const { notifyError } = useMessage()
  const [isDragging, setIsDragging] = React.useState(false)
  const [isHovered, setIsHovered] = React.useState(false)
  const [isKeyboardFocused, setIsKeyboardFocused] = React.useState(false)
  const fileInputRef = React.useRef<HTMLInputElement | null>(null)
  const containerRef = React.useRef<HTMLDivElement | null>(null)
  const pasteTargetTokenRef = React.useRef(Symbol('quick-app-image-paste-target'))
  const isPasteTargetActive = isHovered || isKeyboardFocused

  const readNavigatorClipboardImage = React.useCallback(async (): Promise<File | null> => {
    try {
      if (typeof navigator === 'undefined' || !navigator.clipboard) {
        return null
      }

      if (typeof navigator.clipboard.read !== 'function') {
        return null
      }

      const clipItems = await navigator.clipboard.read()
      for (const clipItem of clipItems) {
        const imageType = clipItem.types.find((type) => type.startsWith('image/'))
        if (!imageType) {
          continue
        }

        const blob = await clipItem.getType(imageType)
        return buildPastedImageFile(blob)
      }
    } catch (error) {
      console.warn('[BaseInputComfyImage] Failed to read image from clipboard:', error)
    }

    return null
  }, [])

  const handleSelectClick = () => {
    if (isLoading) return
    fileInputRef.current?.click()
  }

  const handleClearClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault()
    event.stopPropagation()
    if (isLoading) return
    setIsDragging(false)
    setIsHovered(false)
    setIsKeyboardFocused(false)
    containerRef.current?.blur()
    onClear?.()
  }

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) {
      void doUpload(file)
      e.target.value = ''
    }
  }

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    if (!isDragging) setIsDragging(true)
  }

  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    if (isDragging) setIsDragging(false)
  }

  const handleDrop = async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)

    try {
      const dropError = getDroppedImageDropError(e.dataTransfer)
      if (dropError) {
        const internalPayload = parseInternalImageDragPayload(e.dataTransfer)
        const hasInternalFilePayload = Boolean(
          internalPayload?.itemTypes?.includes('file') ||
          internalPayload?.attachments?.some((attachment) => attachment.type === 'file')
        )
        notifyError(hasInternalFilePayload ? UNSUPPORTED_INTERNAL_FILE_DROP_MESSAGE : dropError)
        return
      }

      const file = await getDroppedImageFile(e.dataTransfer)
      if (!file) {
        notifyError(t('input.image.drop_image_file'))
        return
      }

      await doUpload(file)
      e.dataTransfer.clearData()
    } catch (err) {
      console.error(t('input.image.internal_drop_failed'), err)
      notifyError(
        t('input.image.load_failed', { error: err instanceof Error ? err.message : String(err) })
      )
    }
  }

  const handlePaste = React.useCallback(
    (e: ClipboardEvent) => {
      if (!isPasteTargetActive) return

      const items = e.clipboardData?.items
      if (!items) return

      for (let i = 0; i < items.length; i++) {
        const item = items[i]
        if (item.type.indexOf('image') !== -1) {
          e.preventDefault()
          e.stopImmediatePropagation()
          const blob = item.getAsFile()
          if (blob) {
            void doUpload(buildPastedImageFile(blob))
          }
          break
        }
      }
    },
    [isPasteTargetActive, doUpload]
  )

  const handlePasteShortcut = React.useCallback(
    (event: KeyboardEvent) => {
      if (!isPasteTargetActive || !isPasteShortcut(event)) {
        return
      }

      if (typeof navigator === 'undefined' || !navigator.clipboard) {
        return
      }

      if (typeof navigator.clipboard.read !== 'function') {
        return
      }

      event.preventDefault()
      event.stopImmediatePropagation()

      void (async () => {
        const file = await readNavigatorClipboardImage()
        if (file) {
          await doUpload(file)
        }
      })()
    },
    [doUpload, isPasteTargetActive, readNavigatorClipboardImage]
  )

  React.useEffect(() => {
    const token = pasteTargetTokenRef.current

    if (isPasteTargetActive) {
      activateQuickAppImagePasteTarget(token)
    } else {
      deactivateQuickAppImagePasteTarget(token)
    }

    return () => {
      deactivateQuickAppImagePasteTarget(token)
    }
  }, [isPasteTargetActive])

  React.useEffect(() => {
    const container = containerRef.current
    if (!container) return

    document.addEventListener('paste', handlePaste)
    return () => {
      document.removeEventListener('paste', handlePaste)
    }
  }, [handlePaste])

  React.useEffect(() => {
    window.addEventListener('keydown', handlePasteShortcut, true)
    return () => {
      window.removeEventListener('keydown', handlePasteShortcut, true)
    }
  }, [handlePasteShortcut])

  return (
    <Box data-panel="quick-app">
      <Box sx={{ display: 'flex', alignItems: 'center', mb: 0.5 }}>
        {Icon &&
          React.createElement(Icon, {
            sx: { mr: 1, color: 'text.secondary' }
          })}
        <Typography variant="body2" color="text.secondary">
          {label}
        </Typography>
        {buttonSlot}
      </Box>

      <Box
        ref={containerRef}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={handleSelectClick}
        onFocus={() => setIsKeyboardFocused(true)}
        onBlur={() => setIsKeyboardFocused(false)}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
        tabIndex={0}
        sx={{
          position: 'relative',
          border: '1px dashed',
          borderColor: isDragging
            ? 'primary.main'
            : isPasteTargetActive
              ? 'primary.light'
              : 'divider',
          borderRadius: 1,
          height: previewUrl ? 180 : 120,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: isLoading ? 'default' : 'pointer',
          overflow: 'hidden',
          outline: 'none'
        }}
      >
        {previewUrl ? (
          <>
            {onClear && (
              <Tooltip title={t('input.image.clear')}>
                <IconButton
                  aria-label={t('input.image.clear')}
                  size="small"
                  onClick={handleClearClick}
                  disabled={isLoading}
                  sx={{
                    position: 'absolute',
                    top: 6,
                    right: 6,
                    zIndex: 1,
                    width: 26,
                    height: 26,
                    bgcolor: 'rgba(0,0,0,0.6)',
                    color: '#ff4d4f',
                    '&:hover': {
                      bgcolor: 'rgba(0,0,0,0.8)',
                      color: '#ff4d4f'
                    }
                  }}
                >
                  <DeleteOutline sx={{ fontSize: 15 }} />
                </IconButton>
              </Tooltip>
            )}
            <img
              src={previewUrl}
              alt={internalValue}
              style={{
                display: 'block',
                maxWidth: '100%',
                maxHeight: '100%',
                width: 'auto',
                height: 'auto',
                objectFit: 'contain'
              }}
            />
          </>
        ) : (
          <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 0.5 }}>
            <IconButton color="default" disabled={isLoading}>
              <UploadOutlined />
            </IconButton>
            <Typography variant="body2" color="text.secondary" textAlign="center">
              {placeholder}
            </Typography>
            {isPasteTargetActive && (
              <Typography
                variant="caption"
                color="primary.main"
                sx={{
                  mt: 0.5,
                  px: 1,
                  py: 0.25,
                  bgcolor: 'primary.main',
                  color: 'primary.contrastText',
                  borderRadius: 0.5,
                  fontSize: '0.7rem'
                }}
              >
                {t('input.image.paste_hint')}
              </Typography>
            )}
          </Box>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          style={{ display: 'none' }}
          onChange={handleFileChange}
        />
      </Box>
    </Box>
  )
}

export default BaseInputComfyImage
