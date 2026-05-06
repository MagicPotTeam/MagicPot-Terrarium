import { ResultItem } from '@shared/qApp/resultTypes'
import ResultIconButtonBase from './ResultIconButtonBase'
import { DeleteOutlined } from '@mui/icons-material'

type ResultIconButtonDeleteProps = {
  tooltip: string
  deleteResult: (id: string) => void
  result: ResultItem
}

const ResultIconButtonDelete = ({ tooltip, deleteResult, result }: ResultIconButtonDeleteProps) => {
  return (
    <ResultIconButtonBase
      tooltip={tooltip}
      onClick={() => deleteResult(result.id)}
      Icon={DeleteOutlined}
    />
  )
}

export default ResultIconButtonDelete
