import { ResultItem, TextItem } from '@shared/qApp/resultTypes'
import { ResultTransformer } from './types'

const transformTexts: ResultTransformer<'texts'> = async (promptId, outputs, workflow) => {
  const textResultItems = Object.entries(outputs).flatMap(([nodeId, output]) => {
    const textItems = output.text
      ? output.text.map(
          (item) =>
            ({
              text: item,
              nodeId: nodeId,
              nodeTitle: workflow[nodeId]?._meta?.title ?? workflow[nodeId]?.class_type ?? nodeId,
              nodeClassType: workflow[nodeId]?.class_type ?? nodeId
            }) satisfies TextItem
        )
      : []

    const tagItems = output.tags
      ? output.tags.map(
          (item) =>
            ({
              text: item,
              nodeId: nodeId,
              nodeTitle: workflow[nodeId]?._meta?.title ?? workflow[nodeId]?.class_type ?? nodeId,
              nodeClassType: workflow[nodeId]?.class_type ?? nodeId
            }) satisfies TextItem
        )
      : []

    return [...textItems, ...tagItems]
  }) satisfies TextItem[]

  if (textResultItems.length === 0) {
    return []
  }

  const textResults = {
    id: crypto.randomUUID(),
    type: 'texts',
    resultItems: textResultItems,
    promptId: promptId
  } satisfies ResultItem

  return [textResults]
}

export default transformTexts
