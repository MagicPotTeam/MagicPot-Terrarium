/* eslint-disable react-refresh/only-export-components */
import React, { useEffect, useMemo, useState } from 'react'
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Typography
} from '@mui/material'
import { useTheme } from '@mui/material/styles'
import {
  AddPhotoAlternate as TextureIcon,
  Download as DownloadIcon,
  ViewInAr as Model3DIcon
} from '@mui/icons-material'
import type { CanvasModel3DItem } from '../types'
import { Canvas3DViewerSurface } from './Canvas3DStage'
import {
  DEFAULT_CANVAS_MODEL3D_SESSION_KEY,
  getSceneInstanceCloneCacheKey,
  getSceneInstanceCloneTextureSignature
} from './modelLoaders/sceneInstanceCloneCacheKey'
import { resolveModel3DViewerQualityPreset } from './model3DViewerQualityPreset'

type Model3DViewerDialogProps = {
  open: boolean
  item: CanvasModel3DItem | null
  onClose: () => void
  onDownload: (item: CanvasModel3DItem) => void
  onImportTextures: (item: CanvasModel3DItem) => void
  sessionKey?: string
  bgColor?: string
  transparentPattern?: string
}

const getDefaultTransparentPattern = (themeMode: 'light' | 'dark') =>
  themeMode === 'light'
    ? 'repeating-conic-gradient(#f7f8fc 0% 25%, #e8edf5 0% 50%)'
    : 'repeating-conic-gradient(#2a2a2a 0% 25%, #1a1a1a 0% 50%)'

export const resolveModel3DViewerStageBackgroundSx = ({
  bgColor,
  transparentPattern,
  themeMode
}: {
  bgColor?: string
  transparentPattern?: string
  themeMode: 'light' | 'dark'
}) => {
  if (bgColor === 'transparent') {
    return {
      backgroundImage: transparentPattern || getDefaultTransparentPattern(themeMode),
      backgroundSize: '20px 20px'
    }
  }

  return {
    backgroundColor: bgColor || (themeMode === 'light' ? '#ffffff' : '#1a1a1a')
  }
}

const Model3DViewerDialog: React.FC<Model3DViewerDialogProps> = ({
  open,
  item,
  onClose,
  onDownload,
  onImportTextures,
  sessionKey,
  bgColor,
  transparentPattern
}) => {
  const theme = useTheme()
  const [hasError, setHasError] = useState(false)
  const [errorMsg, setErrorMsg] = useState('')

  const textureSignature = useMemo(() => {
    return getSceneInstanceCloneTextureSignature(item?.textures)
  }, [item?.textures])

  const textureCount = item?.textures ? Object.keys(item.textures).length : 0
  const qualityPreset = useMemo(
    () =>
      resolveModel3DViewerQualityPreset({
        fileName: item?.fileName ?? '',
        textureCount
      }),
    [item?.fileName, textureCount]
  )
  const resolvedSessionKey = sessionKey?.trim() || DEFAULT_CANVAS_MODEL3D_SESSION_KEY
  const instanceCacheKey = useMemo(
    () =>
      item
        ? getSceneInstanceCloneCacheKey({
            sessionKey: resolvedSessionKey,
            src: item.src,
            fileName: item.fileName,
            itemId: item.id,
            textures: item.textures
          })
        : null,
    [item, resolvedSessionKey]
  )

  useEffect(() => {
    if (!open) return
    setHasError(false)
    setErrorMsg('')
  }, [instanceCacheKey, open])

  const viewerStageBackgroundSx = resolveModel3DViewerStageBackgroundSx({
    bgColor,
    transparentPattern,
    themeMode: theme.palette.mode
  })

  if (!item) return null
  const renderKey = instanceCacheKey ?? `${resolvedSessionKey}:${item.id}:${textureSignature}`

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="xl"
      fullWidth
      slotProps={{
        paper: {
          sx: {
            overflow: 'hidden',
            borderRadius: 3,
            background: 'linear-gradient(180deg, rgba(15,23,42,0.98) 0%, rgba(2,6,23,0.99) 100%)',
            border: '1px solid rgba(148,163,184,0.16)'
          }
        }
      }}
    >
      <DialogTitle sx={{ px: 3, py: 2.25, borderBottom: '1px solid rgba(148,163,184,0.16)' }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25, minWidth: 0 }}>
          <Model3DIcon sx={{ color: '#93c5fd' }} />
          <Box sx={{ minWidth: 0 }}>
            <Typography
              variant="h6"
              sx={{
                fontSize: 18,
                fontWeight: 700,
                color: '#f8fafc',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis'
              }}
            >
              {item.fileName}
            </Typography>
            <Typography variant="body2" sx={{ color: 'rgba(226,232,240,0.72)' }}>
              画布里负责排布，这里负责看 3D 细节
            </Typography>
          </Box>
        </Box>
      </DialogTitle>

      <DialogContent sx={{ p: 0, backgroundColor: '#020617' }}>
        <Box
          sx={{
            position: 'relative',
            minHeight: 420,
            height: { xs: '58vh', md: '72vh' },
            ...viewerStageBackgroundSx
          }}
        >
          {hasError ? (
            <Box
              sx={{
                position: 'absolute',
                inset: 0,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                px: 3,
                textAlign: 'center',
                color: '#f8fafc',
                gap: 1
              }}
            >
              <Model3DIcon sx={{ fontSize: 56, color: '#f87171', opacity: 0.9 }} />
              <Typography variant="h6" sx={{ fontWeight: 700 }}>
                3D 模型加载失败
              </Typography>
              {errorMsg ? (
                <Typography
                  variant="body2"
                  sx={{ color: 'rgba(248,250,252,0.72)', maxWidth: 520, wordBreak: 'break-all' }}
                >
                  {errorMsg}
                </Typography>
              ) : null}
            </Box>
          ) : (
            <Canvas3DViewerSurface
              item={item}
              qualityPreset={qualityPreset}
              renderKey={renderKey}
              instanceCacheKey={instanceCacheKey ?? undefined}
              onError={(message) => {
                setHasError(true)
                setErrorMsg(message)
              }}
            />
          )}

          {!hasError ? (
            <>
              <Box
                sx={{
                  position: 'absolute',
                  top: 16,
                  left: 16,
                  px: 1.5,
                  py: 0.75,
                  borderRadius: 2,
                  backgroundColor: 'rgba(15,23,42,0.78)',
                  border: '1px solid rgba(148,163,184,0.18)',
                  backdropFilter: 'blur(10px)'
                }}
              >
                <Typography variant="body2" sx={{ color: '#f8fafc', fontWeight: 600 }}>
                  拖拽旋转，中键平移，滚轮缩放
                </Typography>
              </Box>

              <Box
                sx={{
                  position: 'absolute',
                  left: 16,
                  right: 16,
                  bottom: 16,
                  px: 1.5,
                  py: 1,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 2,
                  borderRadius: 2,
                  backgroundColor: 'rgba(2,6,23,0.72)',
                  border: '1px solid rgba(148,163,184,0.16)',
                  backdropFilter: 'blur(10px)'
                }}
              >
                <Box sx={{ minWidth: 0 }}>
                  <Typography
                    variant="body2"
                    sx={{
                      color: '#f8fafc',
                      fontWeight: 600,
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis'
                    }}
                  >
                    {item.fileName}
                  </Typography>
                  <Typography variant="caption" sx={{ color: 'rgba(226,232,240,0.72)' }}>
                    {textureCount > 0 ? `已加载 ${textureCount} 个贴图文件` : '未加载额外贴图文件'}
                  </Typography>
                </Box>
                <Typography
                  variant="caption"
                  sx={{ color: 'rgba(226,232,240,0.56)', flexShrink: 0 }}
                >
                  Esc 关闭
                </Typography>
              </Box>
            </>
          ) : null}
        </Box>
      </DialogContent>

      <DialogActions
        sx={{
          px: 3,
          py: 2,
          borderTop: '1px solid rgba(148,163,184,0.16)',
          backgroundColor: 'rgba(2,6,23,0.96)'
        }}
      >
        <Button
          onClick={() => onImportTextures(item)}
          startIcon={<TextureIcon />}
          variant="outlined"
          sx={{
            color: '#cbd5e1',
            borderColor: 'rgba(148,163,184,0.28)',
            '&:hover': { borderColor: 'rgba(148,163,184,0.48)' }
          }}
        >
          加载贴图
        </Button>
        <Button
          onClick={() => onDownload(item)}
          startIcon={<DownloadIcon />}
          variant="contained"
          sx={{
            backgroundColor: '#2563eb',
            '&:hover': { backgroundColor: '#1d4ed8' }
          }}
        >
          下载模型
        </Button>
        <Button onClick={onClose} sx={{ color: '#cbd5e1' }}>
          关闭
        </Button>
      </DialogActions>
    </Dialog>
  )
}

export default React.memo(Model3DViewerDialog)
