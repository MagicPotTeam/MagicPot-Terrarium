import React from 'react'
import { Box, IconButton, Tooltip } from '@mui/material'
import DragIndicatorIcon from '@mui/icons-material/DragIndicator'
import ContentCopy from '@mui/icons-material/ContentCopy'
import Download from '@mui/icons-material/Download'
import SendRoundedIcon from '@mui/icons-material/SendRounded'
import ChatBubbleOutlineIcon from '@mui/icons-material/ChatBubbleOutline'
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome'
import LayersOutlinedIcon from '@mui/icons-material/LayersOutlined'
import { useTranslation } from 'react-i18next'
import type { CanvasItem } from '../types'

const GROUP_LABEL = '\u7ec4\u5408'
const DRAG_TOOLTIP = '\u62d6\u62fd\u6240\u9009\u5143\u7d20'
const COPY_TOOLTIP = '\u590d\u5236\u6240\u9009\u5143\u7d20'
const DOWNLOAD_TOOLTIP = '\u4e0b\u8f7d\u6240\u9009\u5143\u7d20'

type ExactSelectedGroup = {
  id: string
  name: string
  bounds: { x: number; y: number; width: number; height: number }
  validItems: CanvasItem[]
}

type SelectionActionStackPosition = {
  left: number
  top: number
}

type CanvasSelectionActionToolbarProps = {
  exactSelectedGroup: ExactSelectedGroup | null
  selectedItems: CanvasItem[]
  canCreateGroupFromSelection: boolean
  selectionActionStackPosition: SelectionActionStackPosition
  stagePos: { x: number; y: number }
  stageScale: number
  onDragSelectedItems: (items: CanvasItem[], dataTransfer: DataTransfer) => void
  onCopySelectedItems: (items: CanvasItem[]) => void
  onDownloadSelectedItems: (items: CanvasItem[], fileName: string) => void
  onSendSelectedItems: (anchor: HTMLElement, items: CanvasItem[]) => void
  onChatSelectedItems: (items: CanvasItem[]) => void
  onGenerateSelectedItems: (items: CanvasItem[]) => void
  onCreateGroupFromSelection: (anchor: HTMLElement) => void
}

type ToolbarActionButtonProps = {
  className: string
  title: string
  icon: React.ReactNode
  draggable?: boolean
  onDragStart?: (event: React.DragEvent<HTMLButtonElement>) => void
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void
}

const stopToolbarPointerPropagation = (
  event:
    | React.MouseEvent<HTMLElement>
    | React.PointerEvent<HTMLElement>
    | React.TouchEvent<HTMLElement>
) => {
  event.stopPropagation()
  event.nativeEvent.stopImmediatePropagation?.()
}

function getToolbarContainerSx(position: SelectionActionStackPosition) {
  return {
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
    zIndex: 130,
    p: 0.5,
    gap: 0.5
  } as const
}

function ToolbarActionButton({
  className,
  title,
  icon,
  draggable = false,
  onDragStart,
  onClick
}: ToolbarActionButtonProps) {
  return (
    <Tooltip title={title}>
      <IconButton
        className={className}
        size="small"
        draggable={draggable}
        onDragStart={onDragStart}
        onClick={onClick}
        sx={{
          borderRadius: 1,
          color: 'inherit',
          cursor: draggable ? 'default' : 'pointer',
          '&:hover': {
            backgroundColor: 'rgba(255,255,255,0.08)'
          },
          '&:active': draggable
            ? {
                cursor: 'default'
              }
            : undefined
        }}
      >
        {icon}
      </IconButton>
    </Tooltip>
  )
}

export default function CanvasSelectionActionToolbar({
  exactSelectedGroup,
  selectedItems,
  canCreateGroupFromSelection,
  selectionActionStackPosition,
  stagePos,
  stageScale,
  onDragSelectedItems,
  onCopySelectedItems,
  onDownloadSelectedItems,
  onSendSelectedItems,
  onChatSelectedItems,
  onGenerateSelectedItems,
  onCreateGroupFromSelection
}: CanvasSelectionActionToolbarProps) {
  const { t } = useTranslation()
  const getLabel = (key: string, fallback: string) => {
    const value = t(key)
    return value === key ? fallback : value
  }

  const sendLabel = getLabel('canvas.action_send', '\u53d1\u9001')
  const chatLabel = getLabel('canvas.action_send_agent', '\u53d1\u9001\u8d44\u6599\u5230 Agent')
  const generateLabel = getLabel(
    'canvas.action_generate_from_selection',
    '\u6309\u9700\u6c42\u751f\u6210'
  )
  const groupLabel = getLabel('canvas.group_create_button', GROUP_LABEL)

  const toolbarItems = exactSelectedGroup?.validItems ?? selectedItems
  const toolbarFileName = exactSelectedGroup?.name ?? 'canvas-selection'
  const toolbarPosition = selectionActionStackPosition

  return (
    <Box
      className={exactSelectedGroup ? 'group-action-toolbar' : 'selection-action-stack'}
      sx={getToolbarContainerSx(toolbarPosition)}
      onPointerDownCapture={stopToolbarPointerPropagation}
      onMouseDownCapture={stopToolbarPointerPropagation}
      onTouchStartCapture={stopToolbarPointerPropagation}
    >
      <ToolbarActionButton
        className="drag-action-button"
        title={DRAG_TOOLTIP}
        draggable
        onDragStart={(event) => {
          onDragSelectedItems(toolbarItems, event.dataTransfer)
        }}
        icon={<DragIndicatorIcon fontSize="small" />}
      />
      <ToolbarActionButton
        className="copy-action-button"
        title={COPY_TOOLTIP}
        onClick={(event) => {
          event.stopPropagation()
          onCopySelectedItems(toolbarItems)
        }}
        icon={<ContentCopy fontSize="small" />}
      />
      <ToolbarActionButton
        className="download-action-button"
        title={DOWNLOAD_TOOLTIP}
        onClick={(event) => {
          event.stopPropagation()
          onDownloadSelectedItems(toolbarItems, toolbarFileName)
        }}
        icon={<Download fontSize="small" />}
      />
      <ToolbarActionButton
        className="send-action-button"
        title={sendLabel}
        onClick={(event) => {
          event.stopPropagation()
          onSendSelectedItems(event.currentTarget, toolbarItems)
        }}
        icon={<SendRoundedIcon fontSize="small" />}
      />
      <ToolbarActionButton
        className="chat-action-button"
        title={chatLabel}
        onClick={(event) => {
          event.stopPropagation()
          onChatSelectedItems(toolbarItems)
        }}
        icon={<ChatBubbleOutlineIcon fontSize="small" />}
      />
      <ToolbarActionButton
        className="generate-action-button"
        title={generateLabel}
        onClick={(event) => {
          event.stopPropagation()
          onGenerateSelectedItems(toolbarItems)
        }}
        icon={<AutoAwesomeIcon fontSize="small" />}
      />
      {!exactSelectedGroup && canCreateGroupFromSelection && (
        <ToolbarActionButton
          className="group-action-button"
          title={groupLabel}
          onClick={(event) => {
            event.stopPropagation()
            onCreateGroupFromSelection(event.currentTarget)
          }}
          icon={<LayersOutlinedIcon fontSize="small" />}
        />
      )}
    </Box>
  )
}
