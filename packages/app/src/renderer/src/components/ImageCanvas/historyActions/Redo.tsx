import { Redo as RedoIcon } from '@mui/icons-material'
import { IconButton } from '@mui/material'
import { HistoryActionProps } from '../types/history'
import { useHistory } from '../contexts/HistoryContext'

export const Redo = ({}: HistoryActionProps) => {
  const { historyHandler } = useHistory()
  const handleRedo = () => {
    historyHandler.redoHistory()
  }
  return (
    <IconButton onClick={handleRedo}>
      <RedoIcon />
    </IconButton>
  )
}
