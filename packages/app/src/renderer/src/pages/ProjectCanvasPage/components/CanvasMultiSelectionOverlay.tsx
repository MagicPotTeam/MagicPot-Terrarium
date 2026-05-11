import React from 'react'
import { Box, IconButton, Tooltip, Typography } from '@mui/material'
import DragIndicatorIcon from '@mui/icons-material/DragIndicator'
import ContentCopy from '@mui/icons-material/ContentCopy'
import Download from '@mui/icons-material/Download'
import SendIcon from '@mui/icons-material/Send'
import LayersOutlinedIcon from '@mui/icons-material/LayersOutlined'
import CanvasSelectionActionToolbar from './CanvasSelectionActionToolbar'
import {
  SELECTION_ACTION_BUTTON_GAP,
  SELECTION_ACTION_BUTTON_HEIGHT,
  SELECTION_ACTION_BUTTON_WIDTH
} from '../projectCanvasPageShared'
import type { CanvasItem } from '../types'

type ExactSelectedGroup = {
  id: string
  bounds: { x: number; y: number; width: number; height: number }
  validItems: CanvasItem[]
  name: string
}

type SelectionActionStackPosition = {
  left: number
  top: number
}

type CanvasMultiSelectionOverlayProps = {
  selectedItems: CanvasItem[]
  exactSelectedGroup: ExactSelectedGroup | null
  selectionActionStackPosition: SelectionActionStackPosition
  stagePos: { x: number; y: number }
  stageScale: number
  legacyEnabled: boolean
  groupCreateLabel: string
  onDragSelectedItems: (items: CanvasItem[], dataTransfer: DataTransfer) => void
  onCopySelectedItems: (items: CanvasItem[]) => void
  onDownloadSelectedItems: (items: CanvasItem[], fileName: string) => void
  onOpenAgentSendMenu: (anchor: HTMLElement, items: CanvasItem[]) => void
  onChatSelectedItems: (items: CanvasItem[]) => void
  onGenerateSelectedItems: (items: CanvasItem[]) => void
  onCreateGroup: () => void
}

type LegacyActionButtonProps = {
  className: string
  label: string
  icon: React.ReactNode
  draggable?: boolean
  onDragStart?: (event: React.DragEvent<HTMLDivElement>) => void
  onClick?: (event: React.MouseEvent<HTMLDivElement>) => void
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

const STACK_BUTTON_SX = {
  width: SELECTION_ACTION_BUTTON_WIDTH,
  minHeight: SELECTION_ACTION_BUTTON_HEIGHT,
  display: 'flex',
  alignItems: 'center',
  bgcolor: '#2b2d31',
  borderRadius: 1.5,
  boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
  border: '1px solid',
  borderColor: 'rgba(255,255,255,0.08)',
  overflow: 'hidden',
  transition:
    'background-color 0.15s ease-out, box-shadow 0.15s ease-out, transform 0.15s ease-out',
  '&:hover': {
    bgcolor: '#383a40',
    boxShadow: '0 6px 20px rgba(0,0,0,0.6)',
    transform: 'scale(1.02)'
  }
} as const

function LegacyActionButton({
  className,
  label,
  icon,
  draggable = false,
  onDragStart,
  onClick
}: LegacyActionButtonProps) {
  return (
    <Box
      className={className}
      draggable={draggable}
      onDragStart={onDragStart}
      onClick={onClick}
      sx={{
        ...STACK_BUTTON_SX,
        cursor: draggable ? 'default' : 'pointer',
        '&:active': draggable
          ? {
              cursor: 'default'
            }
          : undefined
      }}
    >
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          px: 1.25,
          py: 0.75,
          gap: 0.75
        }}
      >
        {icon}
        <Typography
          variant="body2"
          sx={{
            fontWeight: 600,
            color: '#e2e8f0',
            fontSize: 13,
            display: 'flex',
            alignItems: 'center'
          }}
        >
          {label}
        </Typography>
      </Box>
    </Box>
  )
}

export default function CanvasMultiSelectionOverlay({
  selectedItems,
  exactSelectedGroup,
  selectionActionStackPosition,
  stagePos,
  stageScale,
  legacyEnabled,
  groupCreateLabel,
  onDragSelectedItems,
  onCopySelectedItems,
  onDownloadSelectedItems,
  onOpenAgentSendMenu,
  onChatSelectedItems,
  onGenerateSelectedItems,
  onCreateGroup
}: CanvasMultiSelectionOverlayProps) {
  if (selectedItems.length === 0) {
    return null
  }

  const dragLabel = '\u62d6\u62fd'
  const copyLabel = '\u590d\u5236'
  const downloadLabel = '\u4e0b\u8f7d'
  const sendLabel = '\u53d1\u9001'

  return (
    <>
      <CanvasSelectionActionToolbar
        exactSelectedGroup={exactSelectedGroup}
        selectedItems={selectedItems}
        canCreateGroupFromSelection={selectedItems.length > 1}
        selectionActionStackPosition={selectionActionStackPosition}
        stagePos={stagePos}
        stageScale={stageScale}
        onDragSelectedItems={onDragSelectedItems}
        onCopySelectedItems={onCopySelectedItems}
        onDownloadSelectedItems={onDownloadSelectedItems}
        onSendSelectedItems={onOpenAgentSendMenu}
        onChatSelectedItems={onChatSelectedItems}
        onGenerateSelectedItems={onGenerateSelectedItems}
        onCreateGroupFromSelection={() => {
          onCreateGroup()
        }}
      />

      {legacyEnabled && exactSelectedGroup && (
        <Box
          className="group-action-toolbar"
          sx={{
            position: 'absolute',
            left: selectionActionStackPosition.left,
            top: selectionActionStackPosition.top,
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
          }}
          onPointerDownCapture={stopToolbarPointerPropagation}
          onMouseDownCapture={stopToolbarPointerPropagation}
          onTouchStartCapture={stopToolbarPointerPropagation}
        >
          <Tooltip title={dragLabel}>
            <IconButton
              size="small"
              draggable
              onDragStart={(event) => {
                onDragSelectedItems(exactSelectedGroup.validItems, event.dataTransfer)
              }}
              sx={{ cursor: 'default', '&:active': { cursor: 'default' } }}
            >
              <DragIndicatorIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          <Tooltip title={copyLabel}>
            <IconButton
              size="small"
              onClick={() => {
                onCopySelectedItems(exactSelectedGroup.validItems)
              }}
            >
              <ContentCopy fontSize="small" />
            </IconButton>
          </Tooltip>
          <Tooltip title={downloadLabel}>
            <IconButton
              size="small"
              onClick={() => {
                onDownloadSelectedItems(exactSelectedGroup.validItems, exactSelectedGroup.name)
              }}
            >
              <Download fontSize="small" />
            </IconButton>
          </Tooltip>
          <Tooltip title={sendLabel}>
            <IconButton
              size="small"
              onClick={(event) => {
                onOpenAgentSendMenu(event.currentTarget, exactSelectedGroup.validItems)
              }}
            >
              <SendIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Box>
      )}

      {legacyEnabled && !exactSelectedGroup && (
        <Box
          className="selection-action-stack"
          sx={{
            position: 'absolute',
            left: selectionActionStackPosition.left,
            top: selectionActionStackPosition.top,
            display: 'flex',
            flexDirection: 'column',
            gap: `${SELECTION_ACTION_BUTTON_GAP}px`,
            pointerEvents: 'auto',
            zIndex: 130
          }}
          onPointerDownCapture={stopToolbarPointerPropagation}
          onMouseDownCapture={stopToolbarPointerPropagation}
          onTouchStartCapture={stopToolbarPointerPropagation}
        >
          <LegacyActionButton
            className="drag-action-button"
            label={dragLabel}
            draggable
            onDragStart={(event) => {
              onDragSelectedItems(selectedItems, event.dataTransfer)
            }}
            icon={<DragIndicatorIcon sx={{ fontSize: 16, color: '#94a3b8' }} />}
          />
          <LegacyActionButton
            className="copy-action-button"
            label={copyLabel}
            onClick={(event) => {
              event.stopPropagation()
              onCopySelectedItems(selectedItems)
            }}
            icon={<ContentCopy sx={{ fontSize: 16, color: '#94a3b8' }} />}
          />
          <LegacyActionButton
            className="download-action-button"
            label={downloadLabel}
            onClick={(event) => {
              event.stopPropagation()
              onDownloadSelectedItems(selectedItems, 'canvas-selection')
            }}
            icon={<Download sx={{ fontSize: 16, color: '#94a3b8' }} />}
          />
          <LegacyActionButton
            className="chat-action-button"
            label={sendLabel}
            onClick={(event) => {
              event.stopPropagation()
              onOpenAgentSendMenu(event.currentTarget, selectedItems)
            }}
            icon={<SendIcon sx={{ fontSize: 16, color: '#94a3b8' }} />}
          />
          <LegacyActionButton
            className="group-action-button"
            label={groupCreateLabel}
            onClick={(event) => {
              event.stopPropagation()
              onCreateGroup()
            }}
            icon={<LayersOutlinedIcon sx={{ fontSize: 16, color: '#94a3b8' }} />}
          />
        </Box>
      )}
    </>
  )
}
