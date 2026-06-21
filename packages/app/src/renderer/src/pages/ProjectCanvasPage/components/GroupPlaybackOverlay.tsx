/* eslint-disable react-refresh/only-export-components */
import React, { useEffect, useMemo, useRef } from 'react'
import { Box, Button, Typography } from '@mui/material'
import {
  Close as CloseIcon,
  Image as ImageIcon,
  PauseCircleFilled as PauseVideoIcon,
  PlayArrow as PlayArrowIcon,
  ViewInAr as Model3DIcon,
  Videocam as VideoIcon,
  GifBox as GifIcon
} from '@mui/icons-material'
import LazyCanvas3DStage from './LazyCanvas3DStage'
import { getCanvasImageAssetSize } from '../canvasImageAssetUtils'
import type { CanvasImageItem, CanvasModel3DItem, CanvasVideoItem } from '../types'

type GroupPlaybackItem = CanvasImageItem | CanvasVideoItem | CanvasModel3DItem

type ScreenRect = {
  x: number
  y: number
  width: number
  height: number
}

type ViewportSize = {
  width: number
  height: number
}

type GroupPlaybackOverlayLayout = {
  left: number
  top: number
  surfaceWidth: number
  surfaceHeight: number
  mediaWidth: number
  mediaHeight: number
  mediaLeft: number
  mediaTop: number
}

const MIN_SURFACE_WIDTH = 220
const MIN_SURFACE_HEIGHT = 160
const GROUP_PLAYBACK_VIEWPORT_SIDE_MARGIN = 48
const GROUP_PLAYBACK_VIEWPORT_TOP_MARGIN = 40
const GROUP_PLAYBACK_VIEWPORT_BOTTOM_MARGIN = 120
const CORRUPTED_DEFAULT_GROUP_NAME_PREFIX = '缂傚倸鍊搁崐鎼佸磹'
const GROUP_PLAYBACK_IMAGE_LABEL = '图片帧'
const GROUP_PLAYBACK_VIDEO_LABEL = '视频帧'
const GROUP_PLAYBACK_MODEL_LABEL = '3D 预览'
const GROUP_PLAYBACK_RESUME_LABEL = '继续播放'
const GROUP_PLAYBACK_PAUSE_LABEL = '暂停播放'
const GROUP_PLAYBACK_CLOSE_LABEL = '关闭'
const GROUP_PLAYBACK_EXPORT_GIF_LABEL = '导出 GIF'
const EMPTY_GROUP_PLAYBACK_SELECTED_IDS = new Set<string>()

function sanitizePlaybackGroupName(name: string): string {
  return name.includes(CORRUPTED_DEFAULT_GROUP_NAME_PREFIX) ? '组合' : name
}

export function shouldShowGroupPlaybackTransportControl(
  item: GroupPlaybackItem | null,
  totalCount: number
): boolean {
  if (!item) return false
  return item.type === 'video' || totalCount > 1
}

function resolvePlaybackItemBaseSize(item: GroupPlaybackItem) {
  return {
    width: Math.max(1, Math.abs(item.width * (item.scaleX || 1))),
    height: Math.max(1, Math.abs(item.height * (item.scaleY || 1)))
  }
}

function resolvePlaybackRotationBounds(width: number, height: number, rotation = 0) {
  if (!rotation) {
    return { width, height }
  }

  const radians = (rotation * Math.PI) / 180
  const cos = Math.abs(Math.cos(radians))
  const sin = Math.abs(Math.sin(radians))

  return {
    width: Math.max(1, width * cos + height * sin),
    height: Math.max(1, width * sin + height * cos)
  }
}

export function resolveGroupPlaybackOverlayLayout(
  item: GroupPlaybackItem,
  bounds: ScreenRect,
  viewportSize?: ViewportSize | null
): GroupPlaybackOverlayLayout {
  const baseSize = resolvePlaybackItemBaseSize(item)
  const rotationBounds = resolvePlaybackRotationBounds(
    baseSize.width,
    baseSize.height,
    item.rotation
  )
  const frameBaseWidth = Math.max(1, bounds.width)
  const frameBaseHeight = Math.max(1, bounds.height)
  const hasViewport =
    Boolean(viewportSize) && (viewportSize?.width ?? 0) > 0 && (viewportSize?.height ?? 0) > 0
  const availableWidth = hasViewport
    ? Math.max(1, (viewportSize?.width ?? 0) - GROUP_PLAYBACK_VIEWPORT_SIDE_MARGIN * 2)
    : Math.max(frameBaseWidth, MIN_SURFACE_WIDTH)
  const availableHeight = hasViewport
    ? Math.max(
        1,
        (viewportSize?.height ?? 0) -
          GROUP_PLAYBACK_VIEWPORT_TOP_MARGIN -
          GROUP_PLAYBACK_VIEWPORT_BOTTOM_MARGIN
      )
    : Math.max(frameBaseHeight, MIN_SURFACE_HEIGHT)
  const surfaceScale = Math.max(
    0.0001,
    Math.min(availableWidth / frameBaseWidth, availableHeight / frameBaseHeight)
  )
  const surfaceWidth = Math.max(MIN_SURFACE_WIDTH, frameBaseWidth * surfaceScale)
  const surfaceHeight = Math.max(MIN_SURFACE_HEIGHT, frameBaseHeight * surfaceScale)
  const mediaScale = Math.max(
    0.0001,
    Math.min(surfaceWidth / rotationBounds.width, surfaceHeight / rotationBounds.height)
  )
  const mediaWidth = Math.max(1, baseSize.width * mediaScale)
  const mediaHeight = Math.max(1, baseSize.height * mediaScale)
  const left = hasViewport
    ? ((viewportSize?.width ?? 0) - surfaceWidth) / 2
    : bounds.x + (bounds.width - surfaceWidth) / 2
  const top = hasViewport
    ? GROUP_PLAYBACK_VIEWPORT_TOP_MARGIN +
      (availableHeight - Math.min(surfaceHeight, availableHeight)) / 2
    : bounds.y + (bounds.height - surfaceHeight) / 2

  return {
    left,
    top,
    surfaceWidth,
    surfaceHeight,
    mediaWidth,
    mediaHeight,
    mediaLeft: (surfaceWidth - mediaWidth) / 2,
    mediaTop: (surfaceHeight - mediaHeight) / 2
  }
}

const PlaybackVideoFrame: React.FC<{
  item: CanvasVideoItem
  paused: boolean
  onEnded?: () => void
}> = ({ item, paused, onEnded }) => {
  const videoRef = useRef<HTMLVideoElement | null>(null)

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    video.currentTime = 0
    if (!paused) {
      void video.play().catch(() => {})
    }
  }, [item.id])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    if (paused) {
      video.pause()
    } else {
      void video.play().catch(() => {})
    }
  }, [paused])

  return (
    <video
      ref={videoRef}
      src={item.src}
      muted
      playsInline
      preload="metadata"
      onEnded={onEnded}
      style={{
        width: '100%',
        height: '100%',
        objectFit: 'contain',
        display: 'block',
        background: '#020617'
      }}
    />
  )
}

const PlaybackImageFrame: React.FC<{
  item: CanvasImageItem
}> = ({ item }) => {
  const cropStyle = useMemo(() => {
    const crop = item.crop
    const { width: imageWidth, height: imageHeight } = getCanvasImageAssetSize(item.image)
    const sourceWidth = item.sourceWidth || imageWidth
    const sourceHeight = item.sourceHeight || imageHeight
    if (!crop || !sourceWidth || !sourceHeight || crop.width <= 0 || crop.height <= 0) {
      return null
    }

    const scaleX = 100 / crop.width
    const scaleY = 100 / crop.height
    return {
      position: 'absolute' as const,
      left: `${-crop.x * scaleX}%`,
      top: `${-crop.y * scaleY}%`,
      width: `${sourceWidth * scaleX}%`,
      height: `${sourceHeight * scaleY}%`,
      objectFit: 'fill' as const
    }
  }, [item.crop, item.image, item.sourceHeight, item.sourceWidth])

  // Use key={item.id} to force re-mount so GIF animations restart
  if (cropStyle) {
    return (
      <Box sx={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden' }}>
        <Box
          key={item.id}
          component="img"
          src={item.src}
          alt={item.fileName || 'group-playback-image'}
          sx={cropStyle}
        />
      </Box>
    )
  }

  return (
    <Box
      key={item.id}
      component="img"
      src={item.src}
      alt={item.fileName || 'group-playback-image'}
      sx={{
        width: '100%',
        height: '100%',
        objectFit: 'contain',
        display: 'block',
        background: '#020617'
      }}
    />
  )
}

const GroupPlaybackOverlay: React.FC<{
  item: GroupPlaybackItem | null
  bounds: ScreenRect | null
  canvasBounds: ScreenRect | null
  viewportSize?: ViewportSize | null
  sessionKey?: string
  groupName: string
  currentIndex: number
  totalCount: number
  paused: boolean
  onPauseToggle: () => void
  onStop: () => void
  onVideoEnded?: () => void
  onExportGif?: () => void
}> = ({
  item,
  bounds,
  canvasBounds,
  viewportSize,
  sessionKey,
  groupName,
  currentIndex,
  totalCount,
  paused,
  onPauseToggle,
  onStop,
  onVideoEnded,
  onExportGif
}) => {
  if (
    !item ||
    !bounds ||
    !canvasBounds ||
    bounds.width <= 0 ||
    bounds.height <= 0 ||
    canvasBounds.width <= 0 ||
    canvasBounds.height <= 0
  ) {
    return null
  }

  const layout = resolveGroupPlaybackOverlayLayout(item, bounds, viewportSize)
  const frameTransform = [
    item.rotation ? `rotate(${item.rotation}deg)` : '',
    item.scaleX < 0 ? 'scaleX(-1)' : '',
    item.scaleY < 0 ? 'scaleY(-1)' : ''
  ]
    .filter(Boolean)
    .join(' ')

  const previewItem =
    item.type === 'model3d'
      ? ({
          ...item,
          x: 0,
          y: 0,
          width: layout.mediaWidth,
          height: layout.mediaHeight,
          scaleX: 1,
          scaleY: 1,
          rotation: 0
        } as CanvasModel3DItem)
      : null

  const itemLabel =
    item.type === 'image'
      ? GROUP_PLAYBACK_IMAGE_LABEL
      : item.type === 'video'
        ? GROUP_PLAYBACK_VIDEO_LABEL
        : GROUP_PLAYBACK_MODEL_LABEL
  const itemIcon =
    item.type === 'image' ? (
      <ImageIcon sx={{ fontSize: 14 }} />
    ) : item.type === 'video' ? (
      <VideoIcon sx={{ fontSize: 14 }} />
    ) : (
      <Model3DIcon sx={{ fontSize: 14 }} />
    )
  const displayGroupName = sanitizePlaybackGroupName(groupName)
  const showTransportControl = shouldShowGroupPlaybackTransportControl(item, totalCount)

  return (
    <Box sx={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 1200 }}>
      {/* Dark backdrop to hide canvas items behind the playback overlay */}
      <Box
        sx={{
          position: 'absolute',
          inset: 0,
          background: 'rgba(0, 0, 0, 0.85)',
          pointerEvents: 'auto'
        }}
        onClick={onStop}
      />
      <Box
        sx={{
          position: 'absolute',
          left: layout.left,
          top: layout.top,
          width: layout.surfaceWidth,
          height: layout.surfaceHeight,
          borderRadius: 2,
          overflow: 'hidden',
          border: '2px solid rgba(74, 222, 128, 0.95)',
          boxShadow: '0 18px 48px rgba(15,23,42,0.4)',
          background:
            'linear-gradient(180deg, rgba(15,23,42,0.18) 0%, rgba(15,23,42,0.06) 100%), rgba(2,6,23,0.92)'
        }}
      >
        <Box
          sx={{
            position: 'absolute',
            left: layout.mediaLeft,
            top: layout.mediaTop,
            width: layout.mediaWidth,
            height: layout.mediaHeight,
            transform: frameTransform || undefined,
            transformOrigin: 'center center'
          }}
        >
          {item.type === 'image' && <PlaybackImageFrame item={item} />}
          {item.type === 'video' && (
            <PlaybackVideoFrame item={item} paused={paused} onEnded={onVideoEnded} />
          )}
          {item.type === 'model3d' && previewItem && (
            <LazyCanvas3DStage
              items={[previewItem]}
              selectedIds={EMPTY_GROUP_PLAYBACK_SELECTED_IDS}
              stagePos={{ x: 0, y: 0 }}
              stageScale={1}
              stageSize={{ width: layout.mediaWidth, height: layout.mediaHeight }}
              sessionKey={sessionKey}
            />
          )}
        </Box>

        <Box
          sx={{
            position: 'absolute',
            top: 10,
            left: 10,
            px: 1.25,
            py: 0.5,
            borderRadius: 999,
            display: 'flex',
            alignItems: 'center',
            gap: 0.75,
            color: '#e2e8f0',
            background: 'rgba(15,23,42,0.82)',
            backdropFilter: 'blur(8px)'
          }}
        >
          {itemIcon}
          <Typography variant="caption" sx={{ fontWeight: 700, letterSpacing: 0.2 }}>
            {`${displayGroupName} ${currentIndex + 1}/${totalCount}`}
          </Typography>
          <Typography variant="caption" sx={{ color: '#94a3b8' }}>
            {itemLabel}
          </Typography>
        </Box>
      </Box>

      <Box
        sx={{
          position: 'absolute',
          left: layout.left + layout.surfaceWidth / 2,
          top: layout.top + layout.surfaceHeight + 14,
          transform: 'translateX(-50%)',
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          pointerEvents: 'auto'
        }}
      >
        {totalCount > 1 ? (
          <Button
            variant="outlined"
            startIcon={<GifIcon />}
            onClick={onExportGif}
            sx={{
              minWidth: 108,
              borderRadius: 999,
              bgcolor: 'rgba(15,23,42,0.9)',
              color: '#f8fafc',
              borderColor: 'rgba(255,255,255,0.2)',
              backdropFilter: 'blur(8px)'
            }}
          >
            {GROUP_PLAYBACK_EXPORT_GIF_LABEL}
          </Button>
        ) : null}
        <Button
          variant={paused ? 'contained' : 'outlined'}
          color={paused ? 'warning' : 'inherit'}
          startIcon={paused ? <PlayArrowIcon /> : <PauseVideoIcon />}
          onClick={onPauseToggle}
          sx={{
            minWidth: 108,
            borderRadius: 999,
            bgcolor: paused ? undefined : 'rgba(15,23,42,0.9)',
            color: paused ? undefined : '#f8fafc',
            borderColor: paused ? undefined : 'rgba(255,255,255,0.2)',
            backdropFilter: 'blur(8px)',
            display: showTransportControl ? 'inline-flex' : 'none'
          }}
        >
          {paused ? GROUP_PLAYBACK_RESUME_LABEL : GROUP_PLAYBACK_PAUSE_LABEL}
        </Button>
        <Button
          variant="contained"
          color="error"
          startIcon={<CloseIcon />}
          onClick={onStop}
          sx={{
            minWidth: 96,
            borderRadius: 999,
            boxShadow: '0 10px 24px rgba(239,68,68,0.28)'
          }}
        >
          {GROUP_PLAYBACK_CLOSE_LABEL}
        </Button>
      </Box>
    </Box>
  )
}

export default GroupPlaybackOverlay
