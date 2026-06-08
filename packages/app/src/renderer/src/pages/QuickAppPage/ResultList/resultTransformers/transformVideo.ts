import { api } from '@renderer/utils/windowUtils'
import { bytesToObjectUrl } from '@renderer/utils/fileUtils'
import { guessMimeTypeFromFileName } from '@renderer/utils/fileDisplay'
import { ResultTransformer } from './types'
import { ResultItemVideo } from '@shared/qApp/resultTypes'
import { collectVideoFiles } from './mediaOutputs'

const transformVideo: ResultTransformer<'video'> = async (promptId, outputs) => {
  const videoResults = await Promise.all(
    Object.values(outputs)
      .flatMap((output) => collectVideoFiles(output))
      .map(async (item): Promise<ResultItemVideo | null> => {
        try {
          const bytes = await api()
            .svcComfy.getView(item)
            .then((res) => res.result)
          const mimeType = guessMimeTypeFromFileName(item.filename, 'video/mp4')

          return {
            id: crypto.randomUUID(),
            type: 'video',
            objectUrl: bytesToObjectUrl(bytes, mimeType),
            fileItem: item,
            promptId
          } satisfies ResultItemVideo
        } catch (error) {
          console.warn('[transformVideo] failed to load video result:', item, error)
          return null
        }
      })
  )

  return videoResults.filter((result): result is ResultItemVideo => result !== null)
}

export default transformVideo
