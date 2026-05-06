import { Box, Card, Stack, SxProps } from '@mui/material'
import ResultIconButtonDelete from './ResultIconButtonDelete'
import ResultIconButtonInfo from './ResultIconButtonInfo'
import { ResultItem } from '@shared/qApp/resultTypes'

type ResultIconBoxProps = {
  sx: SxProps
  children: React.ReactNode
}

const ResultIconBox = ({ sx, children }: ResultIconBoxProps) => {
  return (
    <Box sx={sx}>
      <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1}>
        {children}
      </Stack>
    </Box>
  )
}

type ResultCardLayoutProps = {
  children: React.ReactNode
  deleteButtonTooltip: string
  result: ResultItem
  resultListMethods?: {
    deleteResult: (id: string) => void
    setInfoPromptId: (promptId: string) => void
  }
  tl?: React.ReactNode[] // 左上角
  tr?: React.ReactNode[] // 右上角
  br?: React.ReactNode[] // 右下角
  bl?: React.ReactNode[] // 左下角
}

export default function ResultCardLayout({
  children,
  tl,
  tr,
  br,
  bl,
  deleteButtonTooltip,
  result,
  resultListMethods
}: ResultCardLayoutProps) {
  const deleteButtons = resultListMethods
    ? [
        <ResultIconButtonDelete
          key="delete"
          tooltip={deleteButtonTooltip}
          deleteResult={resultListMethods.deleteResult}
          result={result}
        />
      ]
    : []

  const infoButtons = resultListMethods
    ? [
        <ResultIconButtonInfo
          key="info"
          setInfoPromptId={resultListMethods.setInfoPromptId}
          result={result}
        />
      ]
    : []

  const newTl = [...deleteButtons, ...(tl || [])]
  const newBr = [...infoButtons, ...(br || [])]

  return (
    <Card sx={{ position: 'relative', minHeight: '100px' }}>
      {children}
      {newTl.length > 0 && (
        <ResultIconBox sx={{ position: 'absolute', top: 8, left: 8 }}>{newTl}</ResultIconBox>
      )}
      {tr && <ResultIconBox sx={{ position: 'absolute', top: 8, right: 8 }}>{tr}</ResultIconBox>}
      {newBr.length > 0 && (
        <ResultIconBox sx={{ position: 'absolute', bottom: 8, right: 8 }}>{newBr}</ResultIconBox>
      )}
      {bl && <ResultIconBox sx={{ position: 'absolute', bottom: 8, left: 8 }}>{bl}</ResultIconBox>}
    </Card>
  )
}
