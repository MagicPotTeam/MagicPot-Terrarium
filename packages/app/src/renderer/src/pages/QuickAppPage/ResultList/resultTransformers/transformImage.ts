import { api } from '@renderer/utils/windowUtils'
import { ResultTransformer } from './types'
import { guessMimeTypeFromFileName } from '@renderer/utils/fileDisplay'
import { ResultItemImage } from '@shared/qApp/resultTypes'
import { collectImageFiles } from './mediaOutputs'
import { readCanvasImageBlobMetadata } from '@renderer/pages/ProjectCanvasPage/canvasAssetIntakeHelpers'
import { SERVICE_INTERNAL_ERROR_CODE } from '@shared/api/apiUtils/serviceValidation'

type ComfyServiceWithOptionalImport = Omit<
  ReturnType<typeof api>['svcComfy'],
  'importOutputImage'
> & {
  importOutputImage?: ReturnType<typeof api>['svcComfy']['importOutputImage']
}

class UnexpectedManagedImportError extends Error {
  constructor(readonly cause: unknown) {
    super('Unexpected managed output import failure')
  }
}

const isFallbackManagedImportTransport = (
  error: unknown
): error is { message: string; code: string } => {
  if (error === null || typeof error !== 'object' || error instanceof Error) return false
  const prototype = Object.getPrototypeOf(error)
  if (prototype !== Object.prototype && prototype !== null) return false
  if (!Object.prototype.hasOwnProperty.call(error, 'code')) return false

  const record = error as Record<string, unknown>
  return (
    typeof record.message === 'string' &&
    typeof record.code === 'string' &&
    record.code !== SERVICE_INTERNAL_ERROR_CODE
  )
}

const loadImageBlobResult = async (
  promptId: string,
  item: ResultItemImage['fileItem']
): Promise<ResultItemImage> => {
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
    promptId,
    ...(metadata ? { sourceWidth: metadata.width, sourceHeight: metadata.height } : {})
  }
}

const transformImageItem = async (
  promptId: string,
  item: ResultItemImage['fileItem']
): Promise<ResultItemImage> => {
  if (item.type === 'output' && typeof item.filename === 'string' && item.filename) {
    const comfyService = api().svcComfy as ComfyServiceWithOptionalImport
    if (typeof comfyService.importOutputImage === 'function') {
      let importPromise: ReturnType<
        NonNullable<ComfyServiceWithOptionalImport['importOutputImage']>
      >
      try {
        importPromise = comfyService.importOutputImage({
          filename: item.filename,
          subfolder: item.subfolder,
          type: 'output'
        })
      } catch (error) {
        throw new UnexpectedManagedImportError(error)
      }

      try {
        const imported = await importPromise
        return {
          id: crypto.randomUUID(),
          type: 'image',
          objectUrl: imported.localMediaUrl,
          fileItem: item,
          promptId,
          media: imported.reference,
          mimeType: imported.mimeType,
          sizeBytes: imported.sizeBytes
        }
      } catch (error) {
        if (!isFallbackManagedImportTransport(error)) {
          throw new UnexpectedManagedImportError(error)
        }
        console.warn(
          '[transformImage] managed output import failed; falling back to bytes:',
          item,
          error
        )
      }
    }
  }

  return loadImageBlobResult(promptId, item)
}

const transformImage: ResultTransformer<'image'> = async (promptId, outputs, workflow) => {
  const imageResults = await Promise.all(
    Object.values(outputs)
      .flatMap((output) => collectImageFiles(output))
      .map(async (item): Promise<ResultItemImage | null> => {
        try {
          return await transformImageItem(promptId, item)
        } catch (error) {
          if (error instanceof UnexpectedManagedImportError) throw error.cause
          console.warn('[transformImage] failed to load image result:', item, error)
          return null
        }
      })
  )
  return imageResults.filter((result): result is ResultItemImage => result !== null)
}

export default transformImage
