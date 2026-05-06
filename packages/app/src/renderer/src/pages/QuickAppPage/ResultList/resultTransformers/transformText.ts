import { ResultItem, ResultItemText } from '@shared/qApp/resultTypes'
import { ResultTransformer } from './types'

const transformText: ResultTransformer<'text'> = async (promptId, outputs, workflow) => {
  const textResultItems = Object.entries(outputs).flatMap(([nodeId, output]) => {
    const textItems = output.text
      ? output.text.map(
          (item) =>
            ({
              id: crypto.randomUUID(),
              type: 'text',
              promptId: promptId,
              text: item,
              nodeId: nodeId,
              nodeTitle: workflow[nodeId]?._meta?.title ?? workflow[nodeId]?.class_type ?? nodeId,
              nodeClassType: workflow[nodeId]?.class_type ?? nodeId
            }) satisfies ResultItemText
        )
      : []
    const tagItems = output.tags
      ? output.tags.map(
          (item) =>
            ({
              id: crypto.randomUUID(),
              type: 'text',
              promptId: promptId,
              text: item,
              nodeId: nodeId,
              nodeTitle: workflow[nodeId]?._meta?.title ?? workflow[nodeId]?.class_type ?? nodeId,
              nodeClassType: workflow[nodeId]?.class_type ?? nodeId
            }) satisfies ResultItemText
        )
      : []
    return [...textItems, ...tagItems]
  }) satisfies ResultItemText[]

  return textResultItems
}

export default transformText
