import { History, HistoryHandler } from '../types/history'
import { Box, Typography } from '@mui/material'
import { Transform } from '../types/transform'
import { useHistory } from '../contexts/HistoryContext'
import { useTransform } from '../contexts/TransformContext'

type DebugInfoProps = {}

export const DebugInfo = ({}: DebugInfoProps) => {
  const { history, historyHandler } = useHistory()
  const { transform } = useTransform()
  return (
    <Box
      sx={{
        bottom: 10,
        right: 10
      }}
    >
      <Typography variant="body2">
        history top: {history.top}
        history length: {history.lines.length}
        current line length: {historyHandler.topLine()?.points.length}
        scale ratio: {transform.scaleRatio}
      </Typography>
    </Box>
  )
}
