import { useEffect, useState } from 'react'
import { Box, IconButton, Tooltip, Typography } from '@mui/material'
import { DeleteOutline } from '@mui/icons-material'
import { loadImage } from './utils/imageUtils'
import { useTranslation } from 'react-i18next'
import { ImageEditToolbar } from './components/ImageEditPanel/ImageEditToolbar'
import { LightingPanel } from './components/ImageEditPanel/LightingPanel'
import { MultiAnglePanel } from './components/ImageEditPanel/MultiAnglePanel'
import { ViewplanePanel } from './components/ImageEditPanel/ViewplanePanel'
import { api } from '@renderer/utils/windowUtils'
import { useMessage } from '@renderer/hooks/useMessage'
import WebGLImageBoard from './WebGLImageBoard'

type ImageViewerProps = {
  imageUrl: string
  onDelete?: () => void
}

export default function ImageViewer({ imageUrl, onDelete }: ImageViewerProps) {
  const { t } = useTranslation()
  const [paint, setPaint] = useState<HTMLImageElement | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  const { notifySuccess, notifyError } = useMessage()
  const [activeTool, setActiveTool] = useState('none')

  const handleDownloadImage = async () => {
    try {
      const DOWNLOAD_DIR_KEY = 'qapp.downloadDir'
      let downloadDir = localStorage.getItem(DOWNLOAD_DIR_KEY)

      if (!downloadDir) {
        const result2 = await api().svcDialog.showOpenDialog({
          title: 'Select image save directory',
          properties: ['openDirectory']
        })
        if (result2.canceled || !result2.filePaths?.length) return
        downloadDir = result2.filePaths[0]
        localStorage.setItem(DOWNLOAD_DIR_KEY, downloadDir)
        api().svcState.saveConfig({ config: { download_dir: downloadDir } })
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
      const fileName = `${t('quickapp.results.generated_image') || 'image'}_${timestamp}.png`
      const response = await fetch(imageUrl)
      const blob = await response.blob()
      const arrayBuffer = await blob.arrayBuffer()
      const data = new Uint8Array(arrayBuffer)
      await api().svcHyper.saveImageToDir({ data, fileName, dir: downloadDir })
      notifySuccess(t('quickapp.results.download_success') || 'Image downloaded successfully')
    } catch (error) {
      console.error('Failed to save image:', error)
      notifyError('Save failed: ' + (error instanceof Error ? error.message : String(error)))
    }
  }

  useEffect(() => {
    let cancelled = false

    setPaint(null)
    setLoadError(null)

    if (!imageUrl) {
      setIsLoading(false)
      return () => {
        cancelled = true
      }
    }

    setIsLoading(true)
    loadImage(imageUrl)
      .then((img) => {
        if (!cancelled) setPaint(img)
      })
      .catch((err) => {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : 'Image failed to load')
        }
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [imageUrl])

  const infoLayout = (children: React.ReactNode) => {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%' }}>
        {children}
      </Box>
    )
  }

  if (isLoading) {
    return infoLayout(<Typography variant="body2">{t('image.loading')}</Typography>)
  }

  if (loadError) {
    return infoLayout(
      <Typography variant="body2" color="error">
        {t('image.load_failed')}: {loadError}
      </Typography>
    )
  }

  if (!paint) {
    return infoLayout(<Typography variant="body2">{t('image.no_data')}</Typography>)
  }

  return (
    <Box
      sx={{
        position: 'relative',
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column'
      }}
    >
      <Box sx={{ position: 'absolute', top: 16, right: 16, zIndex: 10, display: 'flex', gap: 1 }}>
        <ImageEditToolbar
          activeTool={activeTool}
          onSelectTool={setActiveTool}
          onDownload={handleDownloadImage}
        />
        {onDelete ? (
          <Tooltip title="Delete">
            <IconButton onClick={onDelete} sx={{ color: 'error.main' }}>
              <DeleteOutline />
            </IconButton>
          </Tooltip>
        ) : null}
      </Box>
      {activeTool === 'lighting' && (
        <Box sx={{ position: 'absolute', top: 64, right: 16, zIndex: 10 }}>
          <LightingPanel />
        </Box>
      )}
      {activeTool === 'viewplane' && (
        <Box sx={{ position: 'absolute', top: 64, right: 16, zIndex: 10 }}>
          <ViewplanePanel />
        </Box>
      )}
      {activeTool === 'multiAngle' && (
        <Box sx={{ position: 'absolute', top: 64, right: 16, zIndex: 10 }}>
          <MultiAnglePanel />
        </Box>
      )}
      <WebGLImageBoard image={paint} />
    </Box>
  )
}
