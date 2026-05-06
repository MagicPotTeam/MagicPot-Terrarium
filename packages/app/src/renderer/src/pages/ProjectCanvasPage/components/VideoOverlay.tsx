import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Box, IconButton, Slider, Typography } from '@mui/material'
import {
  Pause as PauseIcon,
  PlayArrow as PlayIcon,
  Videocam as VideoIcon,
  VolumeOff as MuteIcon,
  VolumeUp as VolumeIcon
} from '@mui/icons-material'
import { useTranslation } from 'react-i18next'

import type { CanvasVideoItem } from '../types'
import type { ProjectCanvasVideoBudgetMode } from '../projectCanvasRenderBoundary'

type CanvasPoint = {
  x: number
  y: number
}

type VideoDragSession = {
  pointerId: number
  startPoint: CanvasPoint
  startX: number
  startY: number
  latestX: number
  latestY: number
  moved: boolean
}

function formatTime(seconds: number): string {
  const minutes = Math.floor(seconds / 60)
  const remainderSeconds = Math.floor(seconds % 60)
  return `${minutes}:${remainderSeconds.toString().padStart(2, '0')}`
}

function getCanvasPointFromClient(
  canvasContainer: HTMLDivElement | null,
  stagePos: { x: number; y: number },
  stageScale: number,
  clientX: number,
  clientY: number
): CanvasPoint | null {
  if (!canvasContainer) {
    return null
  }

  const rect = canvasContainer.getBoundingClientRect()
  const scale = Math.max(Math.abs(stageScale), 0.0001)

  return {
    x: (clientX - rect.left - stagePos.x) / scale,
    y: (clientY - rect.top - stagePos.y) / scale
  }
}

type VideoOverlayProps = {
  canvasContainerRef: React.RefObject<HTMLDivElement | null>
  item: CanvasVideoItem
  budgetMode: ProjectCanvasVideoBudgetMode
  isSelected: boolean
  showSelectionOutline?: boolean
  stagePos: { x: number; y: number }
  stageScale: number
  allowPointerPassthrough?: boolean
  onSelect: () => void
  onDragEnd: (id: string, x: number, y: number, event?: PointerEvent) => void
  onContextMenu?: (event: MouseEvent | PointerEvent) => void
  onUpdateItem: (id: string, updates: Partial<CanvasVideoItem>) => void
}

const VideoOverlay: React.FC<VideoOverlayProps> = ({
  canvasContainerRef,
  item,
  budgetMode,
  isSelected,
  showSelectionOutline,
  stagePos,
  stageScale,
  allowPointerPassthrough = false,
  onSelect,
  onDragEnd,
  onContextMenu,
  onUpdateItem
}) => {
  const { t } = useTranslation()
  const videoRef = useRef<HTMLVideoElement>(null)
  const boxRef = useRef<HTMLElement>(null)
  const syncFrameRef = useRef<number | null>(null)
  const dragSessionRef = useRef<VideoDragSession | null>(null)
  const suppressNextClickRef = useRef(false)
  const lastAudibleVolumeRef = useRef(item.volume > 0 ? item.volume : 0.5)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [isHovered, setIsHovered] = useState(false)
  const [hasError, setHasError] = useState(false)

  const isPosterFrame = budgetMode === 'poster-frame'
  const shouldMountVideo = budgetMode === 'active-playing' || budgetMode === 'visible-paused'
  const isActivelyPlaying = budgetMode === 'active-playing' && item.playing
  const mountedState = shouldMountVideo
    ? 'mounted-media'
    : isPosterFrame
      ? 'poster-frame'
      : 'unmounted'

  useEffect(() => {
    const video = videoRef.current
    if (!video || budgetMode === 'active-playing') {
      return
    }

    video.pause()
  }, [budgetMode, isHovered])

  useEffect(() => {
    const video = videoRef.current
    if (!video) {
      return
    }

    if (budgetMode === 'active-playing' && item.playing) {
      video.muted = item.muted
      video.play().catch(() => {})
      return
    }

    video.pause()
  }, [budgetMode, item.muted, item.playing])

  useEffect(() => {
    const video = videoRef.current
    if (!video) {
      return
    }

    video.muted = item.muted
    video.volume = item.volume
  }, [item.muted, item.volume])

  useEffect(() => {
    if (item.volume > 0) {
      lastAudibleVolumeRef.current = item.volume
    }
  }, [item.volume])

  const handleContextMenu = useCallback(
    (event: React.MouseEvent<HTMLElement>) => {
      event.preventDefault()
      event.stopPropagation()
      onContextMenu?.(event.nativeEvent)
    },
    [onContextMenu]
  )

  const togglePlay = useCallback(
    (event: React.MouseEvent) => {
      event.stopPropagation()
      onUpdateItem(item.id, { playing: !isActivelyPlaying })
    },
    [isActivelyPlaying, item.id, onUpdateItem]
  )

  const toggleMute = useCallback(
    (event: React.MouseEvent) => {
      event.stopPropagation()
      if (item.muted) {
        onUpdateItem(item.id, {
          muted: false,
          volume: item.volume > 0 ? item.volume : lastAudibleVolumeRef.current
        })
        return
      }

      onUpdateItem(item.id, { muted: true })
    },
    [item.id, item.muted, item.volume, onUpdateItem]
  )

  const handleSeek = useCallback((_: Event, value: number | number[]) => {
    const nextTime = value as number
    if (videoRef.current) {
      videoRef.current.currentTime = nextTime
    }
    setCurrentTime(nextTime)
  }, [])

  const handleVolumeChange = useCallback(
    (_: Event, value: number | number[]) => {
      const nextVolume = Math.max(0, Math.min(1, value as number))
      if (nextVolume > 0) {
        lastAudibleVolumeRef.current = nextVolume
      }

      if (videoRef.current) {
        videoRef.current.volume = nextVolume
        videoRef.current.muted = nextVolume <= 0
      }

      onUpdateItem(item.id, {
        volume: nextVolume,
        muted: nextVolume <= 0
      })
    },
    [item.id, onUpdateItem]
  )

  const handleTimeUpdate = useCallback(() => {
    if (videoRef.current) {
      setCurrentTime(videoRef.current.currentTime)
    }
  }, [])

  const handleLoadedMetadata = useCallback(() => {
    if (videoRef.current) {
      setDuration(videoRef.current.duration)
    }
  }, [])

  const applyVideoLayout = useCallback(
    (detail: Pick<CanvasVideoItem, 'x' | 'y' | 'scaleX' | 'scaleY' | 'rotation'>) => {
      if (!boxRef.current) {
        return
      }

      const canvasWidth = item.width * detail.scaleX
      const canvasHeight = item.height * detail.scaleY
      const rotation = detail.rotation ? ` rotate(${detail.rotation}deg)` : ''
      boxRef.current.style.width = `${canvasWidth}px`
      boxRef.current.style.height = `${canvasHeight}px`
      boxRef.current.style.transform = `translate3d(${detail.x}px, ${detail.y}px, 0)${rotation}`
    },
    [item.height, item.width]
  )

  const resetVideoLayout = useCallback(() => {
    applyVideoLayout({
      x: item.x,
      y: item.y,
      scaleX: item.scaleX,
      scaleY: item.scaleY,
      rotation: item.rotation
    })
  }, [applyVideoLayout, item.rotation, item.scaleX, item.scaleY, item.x, item.y])

  useEffect(() => {
    resetVideoLayout()
  }, [resetVideoLayout])

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent).detail
      if (syncFrameRef.current != null) {
        cancelAnimationFrame(syncFrameRef.current)
      }

      syncFrameRef.current = requestAnimationFrame(() => {
        syncFrameRef.current = null
        applyVideoLayout(detail)
      })
    }

    window.addEventListener(`canvas-sync-${item.id}`, handler)
    return () => {
      if (syncFrameRef.current != null) {
        cancelAnimationFrame(syncFrameRef.current)
      }
      window.removeEventListener(`canvas-sync-${item.id}`, handler)
    }
  }, [applyVideoLayout, item.id])

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      const currentSession = dragSessionRef.current
      if (!currentSession || event.pointerId !== currentSession.pointerId) {
        return
      }

      const point = getCanvasPointFromClient(
        canvasContainerRef.current,
        stagePos,
        stageScale,
        event.clientX,
        event.clientY
      )
      if (!point) {
        return
      }

      const deltaX = point.x - currentSession.startPoint.x
      const deltaY = point.y - currentSession.startPoint.y
      const nextX = currentSession.startX + deltaX
      const nextY = currentSession.startY + deltaY
      const moved =
        currentSession.moved ||
        Math.abs(nextX - currentSession.startX) > 0.01 ||
        Math.abs(nextY - currentSession.startY) > 0.01

      dragSessionRef.current = {
        ...currentSession,
        latestX: nextX,
        latestY: nextY,
        moved
      }

      applyVideoLayout({
        x: nextX,
        y: nextY,
        scaleX: item.scaleX,
        scaleY: item.scaleY,
        rotation: item.rotation
      })
    }

    const finishDragSession = (event: PointerEvent, cancel = false) => {
      const currentSession = dragSessionRef.current
      if (!currentSession || event.pointerId !== currentSession.pointerId) {
        return
      }

      dragSessionRef.current = null

      if (cancel) {
        resetVideoLayout()
        return
      }

      if (!currentSession.moved) {
        resetVideoLayout()
        return
      }

      suppressNextClickRef.current = true
      window.setTimeout(() => {
        suppressNextClickRef.current = false
      }, 0)
      onDragEnd(item.id, currentSession.latestX, currentSession.latestY, event)
      onSelect()
    }

    const handlePointerCancel = (event: PointerEvent) => {
      finishDragSession(event, true)
    }

    window.addEventListener('pointermove', handlePointerMove, true)
    window.addEventListener('pointerup', finishDragSession, true)
    window.addEventListener('pointercancel', handlePointerCancel, true)

    return () => {
      window.removeEventListener('pointermove', handlePointerMove, true)
      window.removeEventListener('pointerup', finishDragSession, true)
      window.removeEventListener('pointercancel', handlePointerCancel, true)
    }
  }, [
    applyVideoLayout,
    canvasContainerRef,
    item.id,
    item.rotation,
    item.scaleX,
    item.scaleY,
    onDragEnd,
    onSelect,
    resetVideoLayout,
    stagePos,
    stageScale
  ])

  const handleRootPointerDown = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      if (event.button !== 0 || allowPointerPassthrough || item.locked) {
        return
      }

      const point = getCanvasPointFromClient(
        canvasContainerRef.current,
        stagePos,
        stageScale,
        event.clientX,
        event.clientY
      )
      if (!point) {
        return
      }

      event.preventDefault()

      dragSessionRef.current = {
        pointerId: event.pointerId,
        startPoint: point,
        startX: item.x,
        startY: item.y,
        latestX: item.x,
        latestY: item.y,
        moved: false
      }
    },
    [allowPointerPassthrough, canvasContainerRef, item.locked, item.x, item.y, stagePos, stageScale]
  )

  const handleRootClick = useCallback(() => {
    if (suppressNextClickRef.current) {
      suppressNextClickRef.current = false
      return
    }

    onSelect()
  }, [onSelect])

  const canvasWidth = item.width * item.scaleX
  const canvasHeight = item.height * item.scaleY
  const displayWidth = canvasWidth * stageScale
  const displayHeight = canvasHeight * stageScale
  const isTooSmall = displayWidth < 60 || displayHeight < 60
  const shouldShowSelectionOutline = showSelectionOutline ?? isSelected
  const shouldShowVolumeSlider = canvasWidth > 180

  if (hasError) {
    return (
      <Box
        ref={boxRef}
        data-canvas-item-id={item.id}
        data-canvas-overlay="video"
        data-canvas-video-budget-mode={budgetMode}
        data-canvas-video-mounted-state={mountedState}
        onPointerDown={handleRootPointerDown}
        onClick={handleRootClick}
        onContextMenu={handleContextMenu}
        style={{
          width: canvasWidth,
          height: canvasHeight,
          transform: `translate3d(${item.x}px, ${item.y}px, 0)`
        }}
        sx={{
          position: 'absolute',
          left: 0,
          top: 0,
          transformOrigin: '0 0',
          zIndex: item.zIndex,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          bgcolor: 'rgba(30,30,30,0.85)',
          border: shouldShowSelectionOutline
            ? '2px solid #6366f1'
            : '1px solid rgba(100,100,100,0.3)',
          borderRadius: '6px',
          pointerEvents: allowPointerPassthrough ? 'none' : 'auto',
          cursor: item.locked ? 'pointer' : 'move',
          overflow: 'hidden'
        }}
      >
        <VideoIcon sx={{ fontSize: 32, color: '#ef4444', mb: 0.5, opacity: 0.7 }} />
        <Typography variant="caption" sx={{ color: '#ef4444', textAlign: 'center', px: 1 }}>
          {t('project_canvas.video_load_failed')}
        </Typography>
        <Typography
          variant="caption"
          sx={{ color: 'text.secondary', textAlign: 'center', px: 1, fontSize: 10 }}
        >
          {item.fileName}
        </Typography>
      </Box>
    )
  }

  return (
    <Box
      ref={boxRef}
      data-canvas-item-id={item.id}
      data-canvas-overlay="video"
      data-canvas-video-budget-mode={budgetMode}
      data-canvas-video-mounted-state={mountedState}
      onPointerDown={handleRootPointerDown}
      onClick={handleRootClick}
      onContextMenu={handleContextMenu}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      style={{
        width: canvasWidth,
        height: canvasHeight,
        transform: `translate3d(${item.x}px, ${item.y}px, 0)${item.rotation ? ` rotate(${item.rotation}deg)` : ''}`
      }}
      sx={{
        position: 'absolute',
        left: 0,
        top: 0,
        willChange: 'transform, width, height',
        transformOrigin: '0 0',
        zIndex: item.zIndex,
        borderRadius: '6px',
        overflow: 'hidden',
        border: shouldShowSelectionOutline
          ? '2px solid #6366f1'
          : '1px solid rgba(100,100,100,0.2)',
        boxShadow: shouldShowSelectionOutline
          ? '0 0 16px rgba(99,102,241,0.4)'
          : '0 2px 8px rgba(0,0,0,0.3)',
        transition: 'border-color 0.15s, box-shadow 0.15s',
        pointerEvents: allowPointerPassthrough ? 'none' : 'auto',
        userSelect: 'none',
        cursor: item.locked ? 'pointer' : 'move',
        ...(allowPointerPassthrough
          ? {
              '& *': {
                pointerEvents: 'none !important'
              }
            }
          : null),
        bgcolor: '#000'
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
            bgcolor: 'rgba(30,30,30,0.9)'
          }}
        >
          <VideoIcon
            sx={{ fontSize: Math.min(canvasWidth, canvasHeight) * 0.5, color: '#6366f1' }}
          />
        </Box>
      ) : (
        <>
          {shouldMountVideo ? (
            <video
              ref={videoRef}
              src={item.src}
              style={{
                width: '100%',
                height: '100%',
                objectFit: 'contain',
                display: 'block'
              }}
              draggable={false}
              muted={item.muted}
              loop
              preload="metadata"
              onTimeUpdate={handleTimeUpdate}
              onLoadedMetadata={handleLoadedMetadata}
              onError={() => setHasError(true)}
            />
          ) : (
            <Box
              data-testid={`video-poster-${item.id}`}
              sx={{
                width: '100%',
                height: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                bgcolor: 'rgba(30,30,30,0.92)'
              }}
            >
              <VideoIcon
                sx={{ fontSize: Math.min(canvasWidth, canvasHeight) * 0.4, color: '#6366f1' }}
              />
            </Box>
          )}

          {(isHovered || isSelected) && !isTooSmall && shouldMountVideo && (
            <Box
              sx={{
                position: 'absolute',
                bottom: 0,
                left: 0,
                right: 0,
                background: 'linear-gradient(transparent, rgba(0,0,0,0.85))',
                px: 1,
                pt: 2,
                pb: 0.5,
                display: 'flex',
                flexDirection: 'column',
                gap: 0.3,
                pointerEvents: allowPointerPassthrough ? 'none' : 'auto'
              }}
              onMouseEnter={() => setIsHovered(true)}
              onMouseLeave={() => setIsHovered(false)}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => event.stopPropagation()}
            >
              {canvasWidth > 120 && (
                <Slider
                  aria-label="Video progress"
                  value={currentTime}
                  min={0}
                  max={duration || 1}
                  onChange={handleSeek}
                  size="small"
                  sx={{
                    py: 0.5,
                    color: '#6366f1',
                    '& .MuiSlider-thumb': {
                      width: 10,
                      height: 10,
                      '&:hover, &.Mui-active': { boxShadow: '0 0 0 4px rgba(99,102,241,0.3)' }
                    },
                    '& .MuiSlider-rail': { opacity: 0.3 }
                  }}
                />
              )}

              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                <IconButton size="small" onClick={togglePlay} sx={{ color: '#fff', p: 0.3 }}>
                  {isActivelyPlaying ? (
                    <PauseIcon sx={{ fontSize: 16 }} />
                  ) : (
                    <PlayIcon sx={{ fontSize: 16 }} />
                  )}
                </IconButton>

                <Typography
                  variant="caption"
                  sx={{
                    color: '#ccc',
                    fontSize: 9,
                    minWidth: 50,
                    fontVariantNumeric: 'tabular-nums'
                  }}
                >
                  {formatTime(currentTime)} / {formatTime(duration)}
                </Typography>

                <Box sx={{ flex: 1 }} />

                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.4 }}>
                  <IconButton size="small" onClick={toggleMute} sx={{ color: '#fff', p: 0.3 }}>
                    {item.muted ? (
                      <MuteIcon sx={{ fontSize: 14 }} />
                    ) : (
                      <VolumeIcon sx={{ fontSize: 14 }} />
                    )}
                  </IconButton>

                  {shouldShowVolumeSlider && (
                    <Slider
                      aria-label="Video volume"
                      value={item.volume}
                      min={0}
                      max={1}
                      step={0.05}
                      onChange={handleVolumeChange}
                      size="small"
                      sx={{
                        width: Math.min(80, Math.max(48, canvasWidth * 0.18)),
                        color: '#a5b4fc',
                        '& .MuiSlider-thumb': {
                          width: 8,
                          height: 8,
                          '&:hover, &.Mui-active': {
                            boxShadow: '0 0 0 4px rgba(99,102,241,0.25)'
                          }
                        },
                        '& .MuiSlider-rail': { opacity: 0.3 }
                      }}
                    />
                  )}
                </Box>
              </Box>
            </Box>
          )}

          {!isHovered && !isSelected && (
            <Box
              sx={{
                position: 'absolute',
                top: 6,
                left: 6,
                px: 0.8,
                py: 0.2,
                bgcolor: 'rgba(0,0,0,0.6)',
                borderRadius: '4px',
                display: 'flex',
                alignItems: 'center',
                gap: 0.4
              }}
            >
              <VideoIcon sx={{ fontSize: 10, color: '#a5b4fc' }} />
              <Typography
                variant="caption"
                sx={{
                  color: '#e0e7ff',
                  fontSize: 9,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  maxWidth: canvasWidth * 0.6
                }}
              >
                {item.fileName}
              </Typography>
            </Box>
          )}
        </>
      )}
    </Box>
  )
}

export default React.memo(
  VideoOverlay,
  (prev, next) =>
    prev.item === next.item &&
    prev.budgetMode === next.budgetMode &&
    prev.isSelected === next.isSelected &&
    prev.showSelectionOutline === next.showSelectionOutline &&
    prev.allowPointerPassthrough === next.allowPointerPassthrough &&
    prev.stagePos.x === next.stagePos.x &&
    prev.stagePos.y === next.stagePos.y &&
    prev.stageScale === next.stageScale
)
