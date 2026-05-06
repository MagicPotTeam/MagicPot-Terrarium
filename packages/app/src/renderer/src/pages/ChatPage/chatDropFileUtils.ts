import type { ModelPackageFileEntry } from '../ProjectCanvasPage/modelArchive'

type DragDataTransferItem = DataTransferItem & {
  webkitGetAsEntry?: () => {
    isDirectory?: boolean
  } | null
}

export type DroppedChatFileDescriptor = {
  file: File
  relativePath?: string
}

const IMAGE_FILE_NAME_PATTERN = /\.(avif|bmp|gif|heic|heif|jpe?g|png|svg|tiff?|webp)$/i

const normalizeRelativePath = (value: string | null | undefined): string | undefined => {
  const normalized = String(value || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .trim()

  return normalized || undefined
}

const isImageLikeFile = (file: Pick<File, 'type' | 'name'>): boolean =>
  file.type.startsWith('image/') || IMAGE_FILE_NAME_PATTERN.test(file.name)

export const hasDroppedDirectory = (items: DataTransferItemList | undefined | null): boolean => {
  if (!items?.length) {
    return false
  }

  return Array.from(items).some((item) => {
    if (item.kind !== 'file') {
      return false
    }

    return Boolean((item as DragDataTransferItem).webkitGetAsEntry?.()?.isDirectory)
  })
}

export const resolveDroppedDirectoryImageFiles = (
  entries: ModelPackageFileEntry[]
): DroppedChatFileDescriptor[] => {
  const deduped = new Map<string, DroppedChatFileDescriptor>()

  for (const entry of entries) {
    if (!isImageLikeFile(entry.file)) {
      continue
    }

    const relativePath = normalizeRelativePath(entry.path)
    const dedupeKey = `${relativePath || entry.file.name}:${entry.file.size}:${entry.file.lastModified}`
    if (!deduped.has(dedupeKey)) {
      deduped.set(dedupeKey, {
        file: entry.file,
        relativePath
      })
    }
  }

  return Array.from(deduped.values())
}
