import { useRef, useState, useEffect } from 'react'
import { Layer, Image as KonvaImage, Group } from 'react-konva'
import { Layer as KonvaLayer } from 'konva/lib/Layer'
import { KonvaEventObject } from 'konva/lib/Node'
import { Box, ButtonGroup, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material'
import { ToolInfo, ToolRef, ToolValue } from './types/tools'
import { separateImageChannels, hasAlphaChannel, loadImage } from './utils/imageUtils'
import { PenTool } from './tools/Pen'
import EraserTool from './tools/Eraser'
import HandTool from './tools/Hand'
import { Clear } from './historyActions/Clear'
import { Redo } from './historyActions/Redo'
import { Undo } from './historyActions/Undo'
import { HistoryResults } from './components/HistoryResults'
import { DebugInfo } from './components/DebugInfo'
import { HistoryProvider } from './contexts/HistoryContext'
import { CanvasStage, CanvasStageRef } from './components/CanvasStage'
import { CustomActionButton } from './components/CustomActionButton'
import { ActionCtx } from './types/actions'
import { TransformProvider } from './contexts/TransformContext'
import { useTranslation } from 'react-i18next'
import { BackHand, Brush, CleaningServices } from '@mui/icons-material'
import BaseImageCanvas from './BaseImageCanvas'

type MaskEditorProps = {
  imageUrl: string
  doSave?: (exportMaskCanvas: HTMLCanvasElement) => Promise<void>
  doCancel?: () => Promise<void> | void
}

const MASK_COLOR = '#873fd9' // purple
const MaskPenTool = PenTool(MASK_COLOR)

export default function MaskEditor({ imageUrl, doSave, doCancel }: MaskEditorProps) {
  const { t } = useTranslation()
  // 加载的图像
  const [paint, setPaint] = useState<HTMLImageElement | null>(null)
  // 分离的 mask 图像
  const [mask, setMask] = useState<HTMLImageElement | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const maskLayerRef = useRef<KonvaLayer>(null)

  const tools: ToolInfo[] = [
    {
      Tool: MaskPenTool,
      Icon: Brush,
      key: 'pen'
    },
    {
      Tool: EraserTool,
      Icon: CleaningServices,
      key: 'eraser'
    },
    {
      Tool: HandTool,
      Icon: BackHand,
      key: 'hand'
    }
  ]

  // 加载并分离图像通道
  useEffect(() => {
    let cancelled = false

    setPaint(null)
    setMask(null)
    setLoadError(null)

    if (!imageUrl) {
      setIsLoading(false)
      return () => {
        cancelled = true
      }
    }

    setIsLoading(true)
    const loadImageAndMask = async () => {
      try {
        // 检查图像是否有 alpha 通道
        const hasAlpha = await hasAlphaChannel(imageUrl)
        if (cancelled) return

        if (hasAlpha) {
          // 如果有 alpha 通道，分离 RGB 和 Alpha 通道
          const { rgbImage, alphaImage } = await separateImageChannels(imageUrl, MASK_COLOR)
          if (cancelled) return
          setPaint(rgbImage)
          setMask(alphaImage)
        } else {
          // 如果没有 alpha 通道，直接使用原图像作为 paint，mask 为空
          const img = await loadImage(imageUrl)
          if (cancelled) return
          setPaint(img)
          setMask(null)
        }
      } catch (error) {
        if (cancelled) return
        console.error('图像处理失败:', error)
        setLoadError(error instanceof Error ? error.message : '图像处理失败')
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    }

    void loadImageAndMask()
    return () => {
      cancelled = true
    }
  }, [imageUrl])

  const handleSave = async (ctx: ActionCtx) => {
    if (!paint) {
      throw new Error('No image data available')
    }
    if (!maskLayerRef.current) {
      throw new Error('mask layer not loaded')
    }
    try {
      setIsSaving(true)

      const canvasConfig = ctx.transformHandler.toCanvasConfig(paint.width, paint.height)
      const exportMaskCanvas = maskLayerRef.current?.toCanvas(canvasConfig)
      await doSave?.(exportMaskCanvas)
    } catch (error) {
      console.error('Save failed:', error)
    } finally {
      setIsSaving(false)
    }
  }

  const handleCancel = async (ctx: ActionCtx) => {
    await doCancel?.()
  }

  const InfoLayout = (children: React.ReactNode) => {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%' }}>
        {children}
      </Box>
    )
  }

  if (isLoading) {
    return InfoLayout(<Typography variant="body2">{t('image.loading')}</Typography>)
  }

  if (loadError) {
    return InfoLayout(
      <Typography variant="body2" color="error">
        {t('image.load_failed')}: {loadError}
      </Typography>
    )
  }

  if (!paint) {
    return InfoLayout(<Typography variant="body2">{t('image.no_data')}</Typography>)
  }

  return (
    <BaseImageCanvas
      tools={tools}
      actions={
        <>
          <ButtonGroup>
            <Clear />
            <Undo />
            <Redo />
          </ButtonGroup>
          <CustomActionButton onClick={handleSave} disabled={isSaving} variant="contained">
            Save
          </CustomActionButton>
          <CustomActionButton onClick={handleCancel} variant="outlined">
            Cancel
          </CustomActionButton>
        </>
      }
      paintWidth={paint.width}
      paintHeight={paint.height}
    >
      {(toolRefs) => (
        <>
          <Layer>
            <KonvaImage image={paint} />
          </Layer>
          <Layer ref={maskLayerRef}>
            <Group>
              {mask && <KonvaImage image={mask} />}
              <HistoryResults toolRefs={toolRefs} />
            </Group>
          </Layer>
        </>
      )}
    </BaseImageCanvas>
  )
}
