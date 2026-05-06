import {
  getDroppedImageFile as getSharedDroppedImageFile,
  getDroppedImageUrl,
  isImageOnlyInternalDragPayload,
  parseInternalImageDragPayload
} from '@renderer/utils/droppedImageUtils'

type ImageDragReader = Pick<DataTransfer, 'getData' | 'files'>

const isSupportedImageFile = (file: Pick<File, 'type'>): boolean =>
  file.type.startsWith('image/') && file.type !== 'image/svg+xml'

/**
 * Check whether a DataTransfer object contains image data.
 * Supports both system file drags and MagicPot's internal image drag payloads.
 */
export function hasDroppedImageData(dt: ImageDragReader): boolean {
  const droppedFiles = Array.from(dt.files ?? [])
  if (droppedFiles.some(isSupportedImageFile)) {
    return true
  }

  const internalPayload = parseInternalImageDragPayload(dt)
  if (internalPayload) {
    return isImageOnlyInternalDragPayload(internalPayload)
  }

  return Boolean(getDroppedImageUrl(dt))
}

/**
 * Extract the first image File from a DataTransfer object.
 * Supports both native file drags and MagicPot internal image drags.
 */
export async function getDroppedImageFile(dt: ImageDragReader): Promise<File | null> {
  return getSharedDroppedImageFile(dt)
}
