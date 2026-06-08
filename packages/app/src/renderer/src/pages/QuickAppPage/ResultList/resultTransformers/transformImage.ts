import { api } from '@renderer/utils/windowUtils'
import { ResultTransformer } from './types'
import { guessMimeTypeFromFileName } from '@renderer/utils/fileDisplay'
import { ResultItemImage } from '@shared/qApp/resultTypes'
import { collectImageFiles } from './mediaOutputs'
import { readCanvasImageBlobMetadata } from '@renderer/pages/ProjectCanvasPage/canvasAssetIntakeHelpers'

const transformImage: ResultTransformer<'image'> = async (promptId, outputs, workflow) => {
  const imageResults = await Promise.all(
    Object.values(outputs)
      .flatMap((output) => collectImageFiles(output))
      .map(async (item): Promise<ResultItemImage | null> => {
        try {
          const bytes = await api()
            .svcComfy.getView(item)
            .then((res) => res.result)
          const blob = new Blob([bytes as BlobPart], {
            type: guessMimeTypeFromFileName(item.filename, 'image/png')
          })
          const objectUrl = URL.createObjectURL(blob)
          const metadata = await readCanvasImageBlobMetadata(blob)

          return {
            id: crypto.randomUUID(),
            type: 'image',
            objectUrl,
            sourceBlob: blob,
            fileItem: item,
            promptId: promptId,
            ...(metadata ? { sourceWidth: metadata.width, sourceHeight: metadata.height } : {})
          } satisfies ResultItemImage
        } catch (error) {
          console.warn('[transformImage] failed to load image result:', item, error)
          return null
        }
      })
  )
  return imageResults.filter((result): result is ResultItemImage => result !== null)
}

export default transformImage
