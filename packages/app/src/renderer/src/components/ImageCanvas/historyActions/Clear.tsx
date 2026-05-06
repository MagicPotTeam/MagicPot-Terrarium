import { Clear as ClearIcon } from '@mui/icons-material'
import { IconButton } from '@mui/material'
import { HistoryActionProps } from '../types/history'
import { useHistory } from '../contexts/HistoryContext'

export const Clear = ({}: HistoryActionProps) => {
  const { historyHandler } = useHistory()
  const handleClear = () => {
    historyHandler.clearHistory()
  }
  return (
    <IconButton onClick={handleClear}>
      <ClearIcon />
    </IconButton>
  )
}
