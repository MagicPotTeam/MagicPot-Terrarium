import React from 'react'
import { Colorize as ColorizeIcon } from '@mui/icons-material'
import { Box, IconButton, Popover, Tooltip } from '@mui/material'
import { useTranslation } from 'react-i18next'
import { ColorWheelSquarePicker } from './components/ColorWheelSquarePicker'
import { ANNOTATION_COLORS, BG_COLORS } from './projectCanvasPageShared'
import { getBackgroundColorLabel } from './projectCanvasPageUiCopy'

type ProjectCanvasPageColorPopoversProps = {
  legacyAnnotationPaletteOpen: boolean
  annotationWheelOpen: boolean
  legacyBackgroundPaletteOpen: boolean
  backgroundWheelOpen: boolean
  colorPickerAnchor: HTMLElement | null
  bgColorPickerAnchor: HTMLElement | null
  brushWidthAnchor: HTMLElement | null
  annotationColor: string
  annotationStrokeWidth: number
  bgColor: string
  onCloseColorPicker: () => void
  onCloseBackgroundColorPicker: () => void
  onCloseBrushWidthPicker: () => void
  onSelectAnnotationColor: (color: string) => void
  onUseEyeDropper: () => Promise<void> | void
  onSelectAnnotationStrokeWidth: (size: number) => void
  onDraftBackgroundCustomColor: (color: string) => void
  onSelectBackgroundColor: (color: string) => void
}

export default function ProjectCanvasPageColorPopovers({
  legacyAnnotationPaletteOpen,
  annotationWheelOpen,
  legacyBackgroundPaletteOpen,
  backgroundWheelOpen,
  colorPickerAnchor,
  bgColorPickerAnchor,
  brushWidthAnchor,
  annotationColor,
  annotationStrokeWidth,
  bgColor,
  onCloseColorPicker,
  onCloseBackgroundColorPicker,
  onCloseBrushWidthPicker,
  onSelectAnnotationColor,
  onUseEyeDropper,
  onSelectAnnotationStrokeWidth,
  onDraftBackgroundCustomColor,
  onSelectBackgroundColor
}: ProjectCanvasPageColorPopoversProps) {
  const { i18n } = useTranslation()
  const language = i18n.resolvedLanguage || i18n.language

  return (
    <>
      <Popover
        open={legacyAnnotationPaletteOpen}
        anchorEl={colorPickerAnchor}
        onClose={onCloseColorPicker}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
        transformOrigin={{ vertical: 'top', horizontal: 'center' }}
        slotProps={{
          paper: {
            sx: {
              p: 1.5,
              borderRadius: 2,
              display: 'flex',
              gap: 0.75,
              flexWrap: 'wrap',
              maxWidth: 220
            }
          }
        }}
      >
        {ANNOTATION_COLORS.map((color) => (
          <Box
            key={color}
            onClick={() => {
              onSelectAnnotationColor(color)
              onCloseColorPicker()
            }}
            sx={{
              width: 28,
              height: 28,
              borderRadius: '50%',
              bgcolor: color,
              cursor: 'pointer',
              border: annotationColor === color ? '3px solid' : '2px solid',
              borderColor: annotationColor === color ? 'primary.main' : 'divider',
              transition: 'transform 0.15s, border-color 0.15s',
              '&:hover': {
                transform: 'scale(1.15)',
                borderColor: 'primary.light'
              }
            }}
          />
        ))}
        <Tooltip title="吸管取色">
          <IconButton
            size="small"
            sx={{ width: 28, height: 28, border: '1px solid', borderColor: 'divider', mr: 1 }}
            onClick={() => {
              void onUseEyeDropper()
            }}
          >
            <ColorizeIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Box
          component="label"
          title="自定义颜色"
          sx={{
            width: 28,
            height: 28,
            borderRadius: '50%',
            border: '2px dashed',
            borderColor: 'divider',
            cursor: 'pointer',
            display: 'grid',
            placeItems: 'center',
            fontSize: 16,
            color: 'text.secondary',
            transition: 'transform 0.15s, border-color 0.15s',
            '&:hover': { transform: 'scale(1.15)', borderColor: 'primary.light' }
          }}
        >
          +
          <input
            type="color"
            style={{ display: 'none' }}
            value={annotationColor.startsWith('#') ? annotationColor : '#ef4444'}
            onChange={(event) => {
              onSelectAnnotationColor(event.target.value)
            }}
          />
        </Box>
      </Popover>

      <Popover
        open={Boolean(brushWidthAnchor)}
        anchorEl={brushWidthAnchor}
        onClose={onCloseBrushWidthPicker}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
        transformOrigin={{ vertical: 'top', horizontal: 'center' }}
        slotProps={{
          paper: {
            sx: {
              p: 1,
              mt: 1,
              borderRadius: 2,
              bgcolor: '#2b2d31',
              display: 'flex',
              gap: 0.75
            }
          }
        }}
      >
        {[
          { size: 2, dot: 6 },
          { size: 5, dot: 12 },
          { size: 10, dot: 20 }
        ].map(({ size, dot }) => (
          <Box
            key={size}
            onClick={() => {
              onSelectAnnotationStrokeWidth(size)
              onCloseBrushWidthPicker()
            }}
            sx={{
              width: 32,
              height: 32,
              borderRadius: '50%',
              display: 'grid',
              placeItems: 'center',
              cursor: 'pointer',
              border: '2px solid',
              borderColor: annotationStrokeWidth === size ? annotationColor : 'transparent',
              bgcolor: annotationStrokeWidth === size ? `${annotationColor}22` : 'transparent',
              transition: 'all 0.15s ease',
              '&:hover': {
                bgcolor: `${annotationColor}33`
              }
            }}
          >
            <Box
              sx={{
                width: dot,
                height: dot,
                borderRadius: '50%',
                bgcolor: annotationColor
              }}
            />
          </Box>
        ))}
      </Popover>

      <Popover
        open={legacyBackgroundPaletteOpen}
        anchorEl={bgColorPickerAnchor}
        onClose={onCloseBackgroundColorPicker}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
        transformOrigin={{ vertical: 'top', horizontal: 'center' }}
        slotProps={{
          paper: {
            sx: {
              p: 1.5,
              borderRadius: 2,
              display: 'flex',
              gap: 0.75,
              flexWrap: 'wrap',
              maxWidth: 180
            }
          }
        }}
      >
        {BG_COLORS.map(({ label, value }) => (
          <Box
            key={value}
            title={getBackgroundColorLabel(label, language)}
            onClick={() => {
              onSelectBackgroundColor(value)
              onCloseBackgroundColorPicker()
            }}
            sx={{
              width: 28,
              height: 28,
              borderRadius: '50%',
              cursor: 'pointer',
              border: bgColor === value ? '3px solid' : '2px solid',
              borderColor: bgColor === value ? 'primary.main' : 'divider',
              transition: 'transform 0.15s, border-color 0.15s',
              '&:hover': { transform: 'scale(1.15)', borderColor: 'primary.light' },
              ...(value === 'transparent'
                ? {
                    background: 'repeating-conic-gradient(#888 0% 25%, #555 0% 50%) 0 0 / 8px 8px'
                  }
                : { bgcolor: value })
            }}
          />
        ))}
        <Box
          component="label"
          title="自定义颜色"
          sx={{
            width: 28,
            height: 28,
            borderRadius: '50%',
            border: '2px dashed',
            borderColor: 'divider',
            cursor: 'pointer',
            display: 'grid',
            placeItems: 'center',
            fontSize: 16,
            color: 'text.secondary',
            transition: 'transform 0.15s, border-color 0.15s',
            '&:hover': { transform: 'scale(1.15)', borderColor: 'primary.light' }
          }}
        >
          +
          <input
            type="color"
            style={{ display: 'none' }}
            value={bgColor.startsWith('#') ? bgColor : '#1a1a1a'}
            onChange={(event) => {
              onDraftBackgroundCustomColor(event.target.value)
            }}
            onInput={(event) => {
              onSelectBackgroundColor((event.target as HTMLInputElement).value)
            }}
          />
        </Box>
      </Popover>

      <Popover
        open={annotationWheelOpen}
        anchorEl={colorPickerAnchor}
        onClose={onCloseColorPicker}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
        transformOrigin={{ vertical: 'top', horizontal: 'center' }}
        slotProps={{
          paper: {
            sx: {
              p: 1.5,
              borderRadius: 2,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 1.25
            }
          }
        }}
      >
        <ColorWheelSquarePicker color={annotationColor} onChange={onSelectAnnotationColor} />
      </Popover>

      <Popover
        open={backgroundWheelOpen}
        anchorEl={bgColorPickerAnchor}
        onClose={onCloseBackgroundColorPicker}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
        transformOrigin={{ vertical: 'top', horizontal: 'center' }}
        slotProps={{
          paper: {
            sx: {
              p: 1.5,
              borderRadius: 2,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 1.25
            }
          }
        }}
      >
        <ColorWheelSquarePicker
          color={bgColor === 'transparent' ? '#1a1a1a' : bgColor}
          onChange={onSelectBackgroundColor}
        />
      </Popover>
    </>
  )
}
