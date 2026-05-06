import { ResultItemType, ResultItemTypeMap } from '@shared/qApp/resultTypes'
import { Config } from '@shared/config/config'
import { BuildEnv } from '@shared/config/buildEnv'

export type ResultCardProps<ItemType extends ResultItemType> = {
  result: ResultItemTypeMap[ItemType]
  index: number
  config: Config
  buildEnv: BuildEnv
  resultListMethods?: {
    deleteResult: (id: string) => void
    setInfoPromptId: (promptId: string) => void
    openImagePreview?: (url: string) => void
  }
}

export type ResultCardComponent<ItemType extends ResultItemType> = React.FC<
  ResultCardProps<ItemType>
>
