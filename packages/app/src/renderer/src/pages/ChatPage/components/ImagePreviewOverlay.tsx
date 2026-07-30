import React from 'react'
import { createPortal } from 'react-dom'
import { Box, Button, CircularProgress, IconButton, Typography } from '@mui/material'
import { Close as CloseIcon } from '@mui/icons-material'
import { useTranslation } from 'react-i18next'
import { normalizeLocalMediaUrl } from '../chatPageShared'

interface ImagePreviewOverlayProps {
  previewImage: string
  imageScale: number
  imagePosition: { x: number; y: number }
  isPreviewDragging: boolean
  currentImageIndex: number
  aiImageListLength: number
  closePreview: () => void
  handlePreviewClick: (e: React.MouseEvent) => void
  handlePreviewWheel: (e: React.WheelEvent) => void
  handlePreviewMouseMove: (e: React.MouseEvent) => void
  handlePreviewMouseUp: (e: React.MouseEvent) => void
  handlePreviewMouseDown: (e: React.MouseEvent) => void
  handleImageContextMenu: (event: React.MouseEvent, imageUrl: string) => void
}

type LoadState = { image: string; status: 'loading' | 'loaded' | 'error' }

const getRetrySource = (source: string, retryKey: number): string => {
  const normalized = normalizeLocalMediaUrl(source)
  if (retryKey === 0 || !/^https?:\/\//i.test(normalized)) return normalized

  try {
    const url = new URL(normalized)
    url.searchParams.set('_magicpot_retry', String(retryKey))
    return url.toString()
  } catch {
    return normalized
  }
}

const ImagePreviewOverlay: React.FC<ImagePreviewOverlayProps> = ({
  previewImage,
  imageScale,
  imagePosition,
  isPreviewDragging,
  currentImageIndex,
  aiImageListLength,
  closePreview,
  handlePreviewClick,
  handlePreviewWheel,
  handlePreviewMouseMove,
  handlePreviewMouseUp,
  handlePreviewMouseDown,
  handleImageContextMenu
}) => {
  const { t } = useTranslation()
  const [loadState, setLoadState] = React.useState<LoadState>({
    image: previewImage,
    status: 'loading'
  })
  const [retry, setRetry] = React.useState({ image: previewImage, key: 0 })
  const retryKey = retry.image === previewImage ? retry.key : 0
  const status = loadState.image === previewImage ? loadState.status : 'loading'
  const imageSrc = getRetrySource(previewImage, retryKey)

  const updateFromImage = React.useCallback(
    (image: HTMLImageElement | null) => {
      if (!image || !image.complete) return
      setLoadState({
        image: previewImage,
        status: image.naturalWidth > 0 ? 'loaded' : 'error'
      })
    },
    [previewImage]
  )

  const overlay = (
    <Box
      onClick={(e) => {
        if (e.target === e.currentTarget) closePreview()
      }}
      onDoubleClick={handlePreviewClick}
      onWheel={handlePreviewWheel}
      onMouseMove={handlePreviewMouseMove}
      onMouseUp={handlePreviewMouseUp}
      onMouseLeave={handlePreviewMouseUp}
      sx={{
        position: 'fixed',
        inset: 0,
        bgcolor: 'rgba(0, 0, 0, 0.9)',
        zIndex: 2147483646,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: isPreviewDragging ? 'grabbing' : 'default',
        overflow: 'hidden',
        isolation: 'isolate'
      }}
    >
      <IconButton
        aria-label={t('chat.close_image_preview', { defaultValue: 'Close image preview' })}
        onClick={closePreview}
        sx={{
          position: 'absolute',
          top: 16,
          right: 16,
          color: 'white',
          bgcolor: 'rgba(255, 255, 255, 0.1)',
          zIndex: 2147483647,
          '&:hover': { bgcolor: 'rgba(255, 255, 255, 0.2)' }
        }}
      >
        <CloseIcon />
      </IconButton>
      <Typography
        sx={{
          position: 'absolute',
          bottom: 16,
          left: '50%',
          transform: 'translateX(-50%)',
          color: 'rgba(255, 255, 255, 0.7)',
          fontSize: '12px',
          bgcolor: 'rgba(0, 0, 0, 0.5)',
          px: 2,
          py: 0.5,
          borderRadius: 1,
          userSelect: 'none'
        }}
      >
        {currentImageIndex !== -1 && aiImageListLength > 1 && (
          <>
            {currentImageIndex + 1}/{aiImageListLength} |{' '}
          </>
        )}
        {t('chat.preview_controls', { scale: Math.round(imageScale * 100) })}
      </Typography>
      {status === 'loading' && (
        <Box
          role="status"
          aria-label={t('chat.image_loading', { defaultValue: 'Loading image' })}
          sx={{
            position: 'absolute',
            display: 'flex',
            flexDirection: 'column',
            gap: 1,
            alignItems: 'center',
            color: 'white'
          }}
        >
          <CircularProgress color="inherit" />
          <Typography variant="body2">
            {t('chat.image_loading', { defaultValue: 'Loading image' })}…
          </Typography>
        </Box>
      )}
      {status === 'error' ? (
        <Box
          role="alert"
          sx={{
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
            alignItems: 'center',
            color: 'white'
          }}
        >
          <Typography>
            {t('chat.image_load_failed', { defaultValue: 'Image failed to load' })}
          </Typography>
          <Box sx={{ display: 'flex', gap: 1 }}>
            <Button
              variant="contained"
              onClick={() => {
                setLoadState({ image: previewImage, status: 'loading' })
                setRetry({ image: previewImage, key: retryKey + 1 })
              }}
            >
              {t('chat.retry_image', { defaultValue: 'Retry image' })}
            </Button>
            <Button variant="outlined" color="inherit" onClick={closePreview}>
              {t('chat.close_image_preview', { defaultValue: 'Close image preview' })}
            </Button>
          </Box>
        </Box>
      ) : (
        <img
          key={`${previewImage}:${retryKey}`}
          ref={updateFromImage}
          src={imageSrc}
          alt={t('chat.preview_alt')}
          loading="eager"
          decoding="async"
          draggable={false}
          style={{
            maxWidth: '95vw',
            maxHeight: '95vh',
            objectFit: 'contain',
            borderRadius: '8px',
            cursor: isPreviewDragging ? 'grabbing' : 'grab',
            transform: `translate(${imagePosition.x}px, ${imagePosition.y}px) scale(${imageScale})`,
            transition: isPreviewDragging ? 'none' : 'transform 0.1s ease-out',
            userSelect: 'none',
            visibility: status === 'loaded' ? 'visible' : 'hidden'
          }}
          onLoad={() => setLoadState({ image: previewImage, status: 'loaded' })}
          onError={() => setLoadState({ image: previewImage, status: 'error' })}
          onMouseDown={handlePreviewMouseDown}
          onContextMenu={(e) => handleImageContextMenu(e, previewImage)}
        />
      )}
    </Box>
  )

  if (typeof document === 'undefined') return overlay
  return createPortal(overlay, document.body)
}

export default ImagePreviewOverlay
