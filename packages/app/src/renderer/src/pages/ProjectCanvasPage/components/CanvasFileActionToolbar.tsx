import React from 'react'
import { Box, IconButton, Tooltip } from '@mui/material'
import DragIndicatorIcon from '@mui/icons-material/DragIndicator'
import SendIcon from '@mui/icons-material/Send'
import { useTranslation } from 'react-i18next'

type CanvasFileActionToolbarProps = {
  position: {
    left: number
    top: number
  }
  onDragStart: (event: React.DragEvent<HTMLButtonElement>) => void
  onChat: () => void
}

const DRAG_TOOLTIP = 'Drag file node'

const stopToolbarPointerPropagation = (
  event:
    | React.MouseEvent<HTMLElement>
    | React.PointerEvent<HTMLElement>
    | React.TouchEvent<HTMLElement>
) => {
  event.stopPropagation()
  event.nativeEvent.stopImmediatePropagation?.()
}

export default function CanvasFileActionToolbar({
  position,
  onDragStart,
  onChat
}: CanvasFileActionToolbarProps) {
  const { t } = useTranslation()
  const sendLabel = (() => {
    const value = t('canvas.action_send')
    return value === 'canvas.action_send' ? '\u53d1\u9001' : value
  })()

  return (
    <Box
      className="file-action-toolbar"
      sx={{
        position: 'absolute',
        left: position.left,
        top: position.top,
        transform: 'translate(-50%, 0)',
        display: 'flex',
        bgcolor: 'background.paper',
        borderRadius: 2,
        boxShadow: '0 4px 12px rgba(0,0,0,0.2)',
        border: '1px solid',
        borderColor: 'divider',
        pointerEvents: 'auto',
        zIndex: 105,
        p: 0.5,
        gap: 0.5
      }}
      onPointerDownCapture={stopToolbarPointerPropagation}
      onMouseDownCapture={stopToolbarPointerPropagation}
      onTouchStartCapture={stopToolbarPointerPropagation}
    >
      <Tooltip title={DRAG_TOOLTIP}>
        <IconButton
          className="drag-action-button"
          size="small"
          draggable
          onDragStart={onDragStart}
          sx={{ cursor: 'default', '&:active': { cursor: 'default' } }}
        >
          <DragIndicatorIcon fontSize="small" />
        </IconButton>
      </Tooltip>
      <Tooltip title={sendLabel}>
        <IconButton className="send-action-button" size="small" onClick={onChat}>
          <SendIcon fontSize="small" />
        </IconButton>
      </Tooltip>
    </Box>
  )
}
