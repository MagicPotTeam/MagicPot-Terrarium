import { IconButton } from '@mui/material'
import { Undo as UndoIcon } from '@mui/icons-material'
import { HistoryActionProps } from '../types/history'
import { useHistory } from '../contexts/HistoryContext'

export const Undo = ({}: HistoryActionProps) => {
  const { historyHandler } = useHistory()
  const handleUndo = () => {
    historyHandler.undoHistory()
  }
  return (
    <IconButton onClick={handleUndo}>
      <UndoIcon />
    </IconButton>
  )
}
