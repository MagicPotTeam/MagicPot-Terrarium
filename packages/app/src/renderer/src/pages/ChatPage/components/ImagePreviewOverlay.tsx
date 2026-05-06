import React from 'react'
import { createPortal } from 'react-dom'
import { Box, IconButton, Typography } from '@mui/material'
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
      {/* 关闭按钮 */}
      <IconButton
        onClick={closePreview}
        sx={{
          position: 'absolute',
          top: 16,
          right: 16,
          color: 'white',
          bgcolor: 'rgba(255, 255, 255, 0.1)',
          zIndex: 2147483647,
          '&:hover': {
            bgcolor: 'rgba(255, 255, 255, 0.2)'
          }
        }}
      >
        <CloseIcon />
      </IconButton>
      {/* 缩放提示 */}
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
      <img
        src={normalizeLocalMediaUrl(previewImage || '')}
        alt={t('chat.preview_alt')}
        draggable={false}
        style={{
          maxWidth: '95vw',
          maxHeight: '95vh',
          objectFit: 'contain',
          borderRadius: '8px',
          cursor: isPreviewDragging ? 'grabbing' : 'grab',
          transform: `translate(${imagePosition.x}px, ${imagePosition.y}px) scale(${imageScale})`,
          transition: isPreviewDragging ? 'none' : 'transform 0.1s ease-out',
          userSelect: 'none'
        }}
        onMouseDown={handlePreviewMouseDown}
        onContextMenu={(e) => handleImageContextMenu(e, previewImage || '')}
      />
    </Box>
  )

  if (typeof document === 'undefined') {
    return overlay
  }

  return createPortal(overlay, document.body)
}

export default ImagePreviewOverlay
