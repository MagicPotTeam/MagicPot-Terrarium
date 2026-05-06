import React from 'react'
import { Box, Typography } from '@mui/material'
import {
  buildFileMetaLine,
  getFileBadgeText,
  getFileTone,
  isBasicEditableFile
} from '@renderer/utils/fileMetadata'
import { isEditableSpreadsheetCanvasFile, type CanvasFileItem } from '../types'

const FILE_NODE_HEADER_TOP = 16
const FILE_NODE_BADGE_X = 16
const FILE_NODE_BADGE_WIDTH = 72
const FILE_NODE_BADGE_HEIGHT = 32
const FILE_NODE_TITLE_X = 104
const FILE_NODE_TITLE_Y = 18
const FILE_NODE_META_Y = 62
const FILE_NODE_PREVIEW_BOX_Y = 86
const FILE_NODE_PREVIEW_BOX_X = 16
const FILE_NODE_PREVIEW_BOX_PADDING = 12

function trimPreviewText(item: CanvasFileItem, canEdit: boolean, maxLength: number): string {
  const preview = (item.previewText || item.content || '').replace(/\s+/g, ' ').trim()
  if (!preview) {
    if (item.fileKind === 'excel' && (item.previewSheets?.length || 0) > 0) {
      return canEdit
        ? 'Double-click to open and edit this spreadsheet.'
        : 'Double-click to open this spreadsheet.'
    }

    return canEdit ? 'Double-click to edit this file.' : 'Preview is not available yet.'
  }

  return preview.length > maxLength ? `${preview.slice(0, Math.max(0, maxLength - 3))}...` : preview
}

type CanvasFileOverlayProps = {
  item: CanvasFileItem
  isSelected: boolean
  showSelectionOutline?: boolean
}

const CanvasFileOverlay: React.FC<CanvasFileOverlayProps> = ({
  item,
  isSelected,
  showSelectionOutline
}) => {
  const shouldShowSelectionOutline = showSelectionOutline ?? isSelected
  const canBasicEdit =
    item.fileKind === 'text' ||
    item.fileKind === 'markdown' ||
    isBasicEditableFile(item.fileName, item.mimeType)
  const canEdit = canBasicEdit || isEditableSpreadsheetCanvasFile(item.fileName)
  const badgeText = getFileBadgeText(item.fileName, item.mimeType)
  const tone = getFileTone(item.fileName, item.mimeType)
  const metaLabel = buildFileMetaLine({
    fileName: item.fileName,
    mimeType: item.mimeType,
    sizeBytes: item.sizeBytes,
    editable: canEdit
  })
  const previewBoxWidth = Math.max(120, item.width - 32)
  const previewBoxHeight = Math.max(56, item.height - 102)
  const hasPreviewImages = Boolean(item.previewImages && item.previewImages.length > 0)
  const hasPreviewText = Boolean(
    (item.previewText || item.content || '').replace(/\s+/g, ' ').trim()
  )
  const shouldShowTextBesideImage = hasPreviewImages && hasPreviewText
  const previewText = trimPreviewText(item, canEdit, shouldShowTextBesideImage ? 128 : 220)
  const previewImage = item.previewImages?.[0]

  return (
    <Box
      data-canvas-item-id={item.id}
      data-canvas-overlay="file"
      style={{
        width: item.width,
        height: item.height,
        transform: `translate3d(${item.x}px, ${item.y}px, 0) rotate(${item.rotation}deg) scale(${item.scaleX}, ${item.scaleY})`
      }}
      sx={{
        position: 'absolute',
        left: 0,
        top: 0,
        boxSizing: 'border-box',
        willChange: 'transform',
        transformOrigin: '0 0',
        zIndex: item.zIndex,
        borderRadius: '16px',
        overflow: 'hidden',
        border: shouldShowSelectionOutline
          ? '2px solid #60a5fa'
          : '1px solid rgba(148,163,184,0.32)',
        boxShadow: shouldShowSelectionOutline
          ? '0 0 16px rgba(15,23,42,0.28)'
          : '0 6px 18px rgba(0,0,0,0.18)',
        bgcolor: '#182330',
        pointerEvents: 'none',
        userSelect: 'none'
      }}
    >
      <Box
        sx={{
          position: 'absolute',
          left: FILE_NODE_BADGE_X,
          top: FILE_NODE_HEADER_TOP,
          width: FILE_NODE_BADGE_WIDTH,
          height: FILE_NODE_BADGE_HEIGHT,
          borderRadius: '10px',
          bgcolor: tone.badgeFill,
          border: `1px solid ${tone.badgeStroke}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center'
        }}
      >
        <Typography sx={{ fontSize: 12, fontWeight: 700, color: tone.accent }}>
          {badgeText}
        </Typography>
      </Box>

      <Typography
        sx={{
          position: 'absolute',
          left: FILE_NODE_TITLE_X,
          top: FILE_NODE_TITLE_Y,
          width: Math.max(60, item.width - 120),
          minHeight: 40,
          color: '#f8fafc',
          fontSize: 16,
          fontWeight: 700,
          lineHeight: 1.2,
          display: '-webkit-box',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          WebkitBoxOrient: 'vertical',
          WebkitLineClamp: 2,
          wordBreak: 'break-word'
        }}
      >
        {item.fileName}
      </Typography>

      <Typography
        sx={{
          position: 'absolute',
          left: FILE_NODE_TITLE_X,
          top: FILE_NODE_META_Y,
          width: Math.max(60, item.width - 120),
          color: tone.accent,
          fontSize: 12,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis'
        }}
      >
        {metaLabel}
      </Typography>

      <Box
        sx={{
          position: 'absolute',
          left: FILE_NODE_PREVIEW_BOX_X,
          top: FILE_NODE_PREVIEW_BOX_Y,
          width: previewBoxWidth,
          height: previewBoxHeight,
          borderRadius: '12px',
          bgcolor: tone.surface,
          border: '1px solid rgba(148,163,184,0.16)',
          overflow: 'hidden',
          p: `${FILE_NODE_PREVIEW_BOX_PADDING}px`,
          boxSizing: 'border-box',
          display: 'flex',
          gap: shouldShowTextBesideImage ? `${FILE_NODE_PREVIEW_BOX_PADDING}px` : 0,
          alignItems: 'stretch',
          justifyContent: 'center'
        }}
      >
        {previewImage ? (
          <Box
            sx={{
              position: 'relative',
              flex: shouldShowTextBesideImage ? '0 0 42%' : '1 1 auto',
              minWidth: shouldShowTextBesideImage ? 96 : 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              overflow: 'hidden'
            }}
          >
            <Box
              component="img"
              src={previewImage.src}
              alt=""
              sx={{
                maxWidth: '100%',
                maxHeight: '100%',
                objectFit: 'contain',
                borderRadius: '8px'
              }}
            />
            <Box
              sx={{
                position: 'absolute',
                right: 0,
                top: 0,
                minWidth: 60,
                px: 1,
                height: 22,
                borderRadius: '11px',
                bgcolor: 'rgba(15,23,42,0.78)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center'
              }}
            >
              <Typography sx={{ fontSize: 11, fontWeight: 700, color: '#e2e8f0' }}>
                {(item.previewImages?.length || 0).toString()} images
              </Typography>
            </Box>
          </Box>
        ) : null}

        <Typography
          sx={{
            flex: '1 1 auto',
            alignSelf: 'stretch',
            color: '#cbd5e1',
            fontSize: previewImage ? 12 : 13,
            lineHeight: 1.45,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            overflow: 'hidden',
            display: '-webkit-box',
            WebkitBoxOrient: 'vertical',
            WebkitLineClamp: previewImage ? 8 : 10
          }}
        >
          {previewText}
        </Typography>
      </Box>
    </Box>
  )
}

export default React.memo(
  CanvasFileOverlay,
  (prev, next) =>
    prev.item === next.item &&
    prev.isSelected === next.isSelected &&
    prev.showSelectionOutline === next.showSelectionOutline
)
