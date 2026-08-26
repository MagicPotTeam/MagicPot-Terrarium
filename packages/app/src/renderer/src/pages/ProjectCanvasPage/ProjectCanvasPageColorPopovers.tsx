import React from 'react'
import { Box, Popover } from '@mui/material'
import { ColorWheelSquarePicker } from './components/ColorWheelSquarePicker'

type ProjectCanvasPageColorPopoversProps = {
  annotationWheelOpen: boolean
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
  onSelectAnnotationStrokeWidth: (size: number) => void
  onSelectBackgroundColor: (color: string) => void
}

export default function ProjectCanvasPageColorPopovers({
  annotationWheelOpen,
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
  onSelectAnnotationStrokeWidth,
  onSelectBackgroundColor
}: ProjectCanvasPageColorPopoversProps) {
  return (
    <>
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
