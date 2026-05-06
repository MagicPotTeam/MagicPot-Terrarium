import { InfoOutlined } from '@mui/icons-material'
import ResultIconButtonBase from './ResultIconButtonBase'
import { ResultItem } from '@shared/qApp/resultTypes'

type ResultIconButtonInfoProps = {
  setInfoPromptId: (promptId: string) => void
  result: ResultItem
}

const ResultIconButtonInfo = ({ setInfoPromptId, result }: ResultIconButtonInfoProps) => {
  return (
    <ResultIconButtonBase
      tooltip="详细信息"
      onClick={() => setInfoPromptId(result.promptId)}
      Icon={InfoOutlined}
    />
  )
}

export default ResultIconButtonInfo
