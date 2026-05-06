import { FileItem, Outputs } from '@shared/comfy/types'
import { guessMimeTypeFromFileName } from '@renderer/utils/fileDisplay'

const VIDEO_OUTPUT_KEYS = new Set(['animated', 'gifs', 'video', 'videos'])
const IMAGE_OUTPUT_KEYS = new Set(['animated', 'gifs', 'images'])

const isFileItem = (value: unknown): value is FileItem =>
  !!value && typeof value === 'object' && !Array.isArray(value)

const buildFileItemKey = (item: FileItem): string =>
  `${item.filename || ''}|${item.subfolder || ''}|${item.type || ''}|${item.format || ''}`

const dedupeFileItems = (items: FileItem[]): FileItem[] => {
  const deduped = new Map<string, FileItem>()
  for (const item of items) {
    deduped.set(buildFileItemKey(item), item)
  }
  return Array.from(deduped.values())
}

const getOutputFileEntries = (output: Outputs): Array<{ key: string; item: FileItem }> =>
  Object.entries(output as Record<string, unknown>).flatMap(([key, value]) =>
    Array.isArray(value)
      ? value.filter(isFileItem).map((item) => ({
          key,
          item
        }))
      : []
  )

const isVideoFileItem = (item: FileItem): boolean =>
  guessMimeTypeFromFileName(item.filename, 'application/octet-stream').startsWith('video/')

const isImageFileItem = (item: FileItem): boolean =>
  guessMimeTypeFromFileName(item.filename, 'application/octet-stream').startsWith('image/')

export const collectVideoFiles = (output: Outputs): FileItem[] =>
  dedupeFileItems(
    getOutputFileEntries(output)
      .filter(
        ({ key, item }) =>
          isVideoFileItem(item) || (VIDEO_OUTPUT_KEYS.has(key) && !isImageFileItem(item))
      )
      .map(({ item }) => item)
  )

export const collectImageFiles = (output: Outputs): FileItem[] => {
  if (collectVideoFiles(output).length > 0) {
    return []
  }

  return dedupeFileItems(
    getOutputFileEntries(output)
      .filter(({ key, item }) => IMAGE_OUTPUT_KEYS.has(key) && isImageFileItem(item))
      .map(({ item }) => item)
  )
}
