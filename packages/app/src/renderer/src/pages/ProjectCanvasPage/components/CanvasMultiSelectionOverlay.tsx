import CanvasSelectionActionToolbar from './CanvasSelectionActionToolbar'
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
  groupCreateLabel: string
  onDragSelectedItems: (items: CanvasItem[], dataTransfer: DataTransfer) => void
  onCopySelectedItems: (items: CanvasItem[]) => void
  onDownloadSelectedItems: (items: CanvasItem[], fileName: string) => void
  onOpenAgentSendMenu: (anchor: HTMLElement, items: CanvasItem[]) => void
  onChatSelectedItems: (items: CanvasItem[]) => void
  onGenerateSelectedItems: (items: CanvasItem[]) => void
  onCreateGroup: () => void
}
export default function CanvasMultiSelectionOverlay({
  selectedItems,
  exactSelectedGroup,
  selectionActionStackPosition,
  stagePos,
  stageScale,
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

  return (
    <CanvasSelectionActionToolbar
      exactSelectedGroup={exactSelectedGroup}
      selectedItems={selectedItems}
      canCreateGroupFromSelection={selectedItems.length > 1}
      selectionActionStackPosition={selectionActionStackPosition}
      stagePos={stagePos}
      stageScale={stageScale}
      groupCreateLabel={groupCreateLabel}
      onDragSelectedItems={onDragSelectedItems}
      onCopySelectedItems={onCopySelectedItems}
      onDownloadSelectedItems={onDownloadSelectedItems}
      onSendSelectedItems={onOpenAgentSendMenu}
      onChatSelectedItems={onChatSelectedItems}
      onGenerateSelectedItems={onGenerateSelectedItems}
      onCreateGroupFromSelection={onCreateGroup}
    />
  )
}
