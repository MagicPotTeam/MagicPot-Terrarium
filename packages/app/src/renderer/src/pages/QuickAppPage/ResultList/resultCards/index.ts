import { ResultItemType } from '@shared/qApp/resultTypes'
import { ResultCardComponent } from './types'
import ResultCardImage from './ResultCardImage'
import ResultCardTexts from './ResultCardTexts'
import ResultCardText from './ResultCardText'
import ResultCardVideo from './ResultCardVideo'

export const ResultCardMap: {
  [K in ResultItemType]: ResultCardComponent<K>
} = {
  image: ResultCardImage,
  video: ResultCardVideo,
  texts: ResultCardTexts,
  text: ResultCardText
}
