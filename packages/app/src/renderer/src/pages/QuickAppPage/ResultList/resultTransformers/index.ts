import { ResultItemType } from '@shared/qApp/resultTypes'
import transformImage from './transformImage'
import transformVideo from './transformVideo'
import transformTexts from './transformTexts'
import transformText from './transformText'
import { ResultTransformer } from './types'
import { ComfyHistory, Outputs } from '@shared/comfy/types'

export const resultTransformers: ResultTransformer<ResultItemType>[] = [
  transformImage,
  transformVideo,
  // transformTexts
  transformText
]

const COMFY_MEDIA_OUTPUT_KEYS = ['images', 'video', 'videos', 'gifs', 'animated'] as const
const TRANSIENT_COMFY_FILE_TYPES = new Set(['temp'])

function stripTransientComfyMediaOutputs(
  outputs: Record<string, Outputs>
): Record<string, Outputs> {
  return Object.fromEntries(
    Object.entries(outputs).map(([nodeId, output]) => {
      const filteredOutput: Outputs = { ...output }

      for (const key of COMFY_MEDIA_OUTPUT_KEYS) {
        const items = output[key]
        if (!Array.isArray(items)) continue

        const retainedItems = items.filter(
          (item) => !TRANSIENT_COMFY_FILE_TYPES.has(item.type || '')
        )
        if (retainedItems.length > 0) {
          filteredOutput[key] = retainedItems
        } else {
          delete filteredOutput[key]
        }
      }

      return [nodeId, filteredOutput]
    })
  )
}

export const transformResults = async (
  promptId: string,
  history: ComfyHistory,
  outputNodeIds?: string[]
) => {
  let outputs = history.outputs
  if (outputNodeIds && outputNodeIds.length > 0) {
    outputs = outputNodeIds.reduce(
      (acc, nodeId) => {
        acc[nodeId] = outputs[nodeId] ?? {}
        return acc
      },
      {} as Record<string, Outputs>
    )
  } else {
    outputs = stripTransientComfyMediaOutputs(outputs)
  }
  const workflow = history.prompt[2]
  const resultItems = await Promise.all(
    resultTransformers.map((transformer) => transformer(promptId, outputs, workflow))
  ).then((results) => results.flat())
  return resultItems
}
