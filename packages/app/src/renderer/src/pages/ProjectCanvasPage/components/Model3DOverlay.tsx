import React from 'react'
import { Box, Badge, IconButton, Tooltip, Typography } from '@mui/material'
import { AddPhotoAlternate as TextureIcon, ViewInAr as Model3DIcon } from '@mui/icons-material'
import Canvas3DStage from './Canvas3DStage'
import { PROJECT_CANVAS_MIN_STAGE_SCALE } from '../projectCanvasViewportScale'
import type { CanvasModel3DItem } from '../types'

const EMPTY_MODEL3D_OVERLAY_SELECTED_IDS = new Set<string>()
const SMALL_MODEL3D_OVERLAY_EDGE_PX = 60

function rotatePoint(point: { x: number; y: number }, rotation: number) {
  const radians = (rotation * Math.PI) / 180
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)
  return {
    x: point.x * cos - point.y * sin,
    y: point.x * sin + point.y * cos
  }
}

function openTexturePicker(
  item: CanvasModel3DItem,
  onUpdateTextures?: (itemId: string, textures: Record<string, string>) => void,
  onCreateTextureUrl?: (url: string) => void
) {
  if (!onUpdateTextures) {
    return
  }

  const input = document.createElement('input')
  input.type = 'file'
  input.multiple = true
  input.accept = 'image/*,.mtl,.mat,.tga,.dds,.hdr,.exr'
  input.onchange = () => {
    const files = input.files
    if (!files || files.length === 0) {
      return
    }

    const nextTextures: Record<string, string> = { ...(item.textures || {}) }
    for (const file of Array.from(files)) {
      const objectUrl = URL.createObjectURL(file)
      onCreateTextureUrl?.(objectUrl)
      nextTextures[file.name] = objectUrl
    }

    onUpdateTextures(item.id, nextTextures)
  }
  input.click()
}

const Model3DOverlay: React.FC<{
  item: CanvasModel3DItem
  isSelected: boolean
  showSelectionOutline?: boolean
  stagePos: { x: number; y: number }
  stageScale: number
  sessionKey?: string
  previewOnly?: boolean
  onSelect: () => void
  onUpdateTextures?: (itemId: string, textures: Record<string, string>) => void
}> = ({
  item,
  isSelected,
  showSelectionOutline,
  stageScale,
  sessionKey,
  previewOnly = false,
  onSelect,
  onUpdateTextures
}) => {
  const ownedTextureObjectUrlsRef = React.useRef(new Set<string>())
  const scaledWidth = item.width * item.scaleX
  const scaledHeight = item.height * item.scaleY
  const frameWidth = Math.max(1, Math.abs(scaledWidth))
  const frameHeight = Math.max(1, Math.abs(scaledHeight))
  const frameOffset = rotatePoint(
    {
      x: Math.min(0, scaledWidth),
      y: Math.min(0, scaledHeight)
    },
    item.rotation
  )
  const frameX = item.x + frameOffset.x
  const frameY = item.y + frameOffset.y
  const safeStageScale = Math.max(Math.abs(stageScale), PROJECT_CANVAS_MIN_STAGE_SCALE)
  const displayWidth = frameWidth * safeStageScale
  const displayHeight = frameHeight * safeStageScale
  const isTooSmall =
    displayWidth < SMALL_MODEL3D_OVERLAY_EDGE_PX || displayHeight < SMALL_MODEL3D_OVERLAY_EDGE_PX
  const shouldShowSelectionOutline = showSelectionOutline ?? isSelected
  const textureCount = item.textures ? Object.keys(item.textures).length : 0
  const previewItem = React.useMemo<CanvasModel3DItem>(
    () => ({
      ...item,
      x: 0,
      y: 0,
      width: frameWidth,
      height: frameHeight,
      scaleX: 1,
      scaleY: 1,
      rotation: 0
    }),
    [frameHeight, frameWidth, item]
  )
  const selectedIds = React.useMemo(
    () =>
      shouldShowSelectionOutline
        ? new Set<string>([previewItem.id])
        : EMPTY_MODEL3D_OVERLAY_SELECTED_IDS,
    [previewItem.id, shouldShowSelectionOutline]
  )
  const revokeOwnedTextureObjectUrl = React.useCallback((url: string) => {
    if (
      ownedTextureObjectUrlsRef.current.delete(url) &&
      typeof URL !== 'undefined' &&
      typeof URL.revokeObjectURL === 'function'
    ) {
      URL.revokeObjectURL(url)
    }
  }, [])

  React.useEffect(() => {
    const activeTextureUrls = new Set(Object.values(item.textures || {}))
    for (const url of Array.from(ownedTextureObjectUrlsRef.current)) {
      if (!activeTextureUrls.has(url)) {
        revokeOwnedTextureObjectUrl(url)
      }
    }
  }, [item.textures, revokeOwnedTextureObjectUrl])

  React.useEffect(
    () => () => {
      for (const url of Array.from(ownedTextureObjectUrlsRef.current)) {
        revokeOwnedTextureObjectUrl(url)
      }
    },
    [revokeOwnedTextureObjectUrl]
  )

  return (
    <Box
      data-canvas-item-id={item.id}
      data-canvas-overlay="model3d"
      onClick={() => {
        if (!previewOnly) {
          onSelect()
        }
      }}
      style={{
        width: frameWidth,
        height: frameHeight,
        transform: `translate3d(${frameX}px, ${frameY}px, 0) rotate(${item.rotation}deg) scale(${item.scaleX < 0 ? -1 : 1}, ${item.scaleY < 0 ? -1 : 1})`
      }}
      sx={{
        position: 'absolute',
        left: 0,
        top: 0,
        boxSizing: 'border-box',
        transformOrigin: '0 0',
        overflow: 'hidden',
        borderRadius: '6px',
        border: shouldShowSelectionOutline ? '2px solid #6366f1' : '1px solid transparent',
        boxShadow: shouldShowSelectionOutline ? '0 0 16px rgba(99,102,241,0.4)' : 'none',
        background: 'rgba(2, 6, 23, 0.92)',
        pointerEvents: previewOnly ? 'none' : 'auto',
        userSelect: 'none'
      }}
    >
      {isTooSmall ? (
        <Box
          sx={{
            width: '100%',
            height: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            bgcolor: 'rgba(15, 23, 42, 0.95)'
          }}
        >
          <Model3DIcon
            sx={{
              color: '#93c5fd',
              fontSize: Math.max(18, Math.min(frameWidth, frameHeight) * 0.5)
            }}
          />
        </Box>
      ) : (
        <Canvas3DStage
          items={[previewItem]}
          selectedIds={selectedIds}
          stagePos={{ x: 0, y: 0 }}
          stageScale={1}
          stageSize={{ width: frameWidth, height: frameHeight }}
          sessionKey={sessionKey}
        />
      )}

      {!previewOnly && onUpdateTextures ? (
        <Tooltip title="Import textures" placement="top">
          <IconButton
            size="small"
            onClick={(event) => {
              event.preventDefault()
              event.stopPropagation()
              openTexturePicker(item, onUpdateTextures, (url) => {
                ownedTextureObjectUrlsRef.current.add(url)
              })
            }}
            sx={{
              position: 'absolute',
              top: 6,
              right: 6,
              bgcolor: textureCount > 0 ? 'rgba(34,197,94,0.85)' : 'rgba(15,23,42,0.82)',
              color: '#fff',
              backdropFilter: 'blur(4px)',
              p: 0.5,
              '&:hover': {
                bgcolor: textureCount > 0 ? 'rgba(34,197,94,1)' : 'rgba(15,23,42,0.95)'
              }
            }}
          >
            <Badge
              badgeContent={textureCount}
              color="primary"
              max={99}
              sx={{
                '& .MuiBadge-badge': {
                  display: textureCount > 0 ? 'flex' : 'none',
                  fontSize: 8,
                  height: 14,
                  minWidth: 14
                }
              }}
            >
              <TextureIcon sx={{ fontSize: 16 }} />
            </Badge>
          </IconButton>
        </Tooltip>
      ) : null}

      {!previewOnly ? (
        <Box
          sx={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 0,
            px: 1,
            py: 0.4,
            display: 'flex',
            alignItems: 'center',
            gap: 0.5,
            background: 'linear-gradient(transparent, rgba(2,6,23,0.82))',
            pointerEvents: 'none'
          }}
        >
          <Model3DIcon sx={{ fontSize: 12, color: '#93c5fd' }} />
          <Typography
            variant="caption"
            sx={{
              color: '#e2e8f0',
              fontSize: 10,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap'
            }}
          >
            {item.fileName}
          </Typography>
        </Box>
      ) : null}
    </Box>
  )
}

export default React.memo(
  Model3DOverlay,
  (previousProps, nextProps) =>
    previousProps.item === nextProps.item &&
    previousProps.isSelected === nextProps.isSelected &&
    previousProps.showSelectionOutline === nextProps.showSelectionOutline &&
    previousProps.stageScale === nextProps.stageScale &&
    previousProps.sessionKey === nextProps.sessionKey &&
    previousProps.previewOnly === nextProps.previewOnly
)
