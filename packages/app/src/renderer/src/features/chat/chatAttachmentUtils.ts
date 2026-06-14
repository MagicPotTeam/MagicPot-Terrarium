import type { ChatAttachment } from '@shared/api/svcLLMProxy'

export const CHAT_MODEL3D_EXTENSIONS = [
  '.glb',
  '.gltf',
  '.obj',
  '.fbx',
  '.dae',
  '.3ds',
  '.ply',
  '.stl'
]

export const getChatAttachmentTypeForFile = (
  file: Pick<File, 'name' | 'type'>
): ChatAttachment['type'] => {
  if (file.type.startsWith('image/')) return 'image'
  if (file.type.startsWith('video/')) return 'video'

  const extensionIndex = file.name.lastIndexOf('.')
  const extension = extensionIndex >= 0 ? file.name.toLowerCase().slice(extensionIndex) : ''
  if (CHAT_MODEL3D_EXTENSIONS.includes(extension)) return 'model3d'

  return 'file'
}

export const getChatAttachmentMaxSizeMB = (type: ChatAttachment['type']): number => {
  if (type === 'video') return 500
  if (type === 'model3d') return 200
  return 50
}

type FileWithOptionalPath = File & { path?: unknown }

export const getLocalFilePath = (file: File): string => {
  const candidate = (file as FileWithOptionalPath).path
  return typeof candidate === 'string' ? candidate.replace(/\\/g, '/') : ''
}

export const summarizeChatAttachmentsForLog = (attachments: ChatAttachment[] | undefined) =>
  attachments?.map((attachment) => ({
    type: attachment.type,
    fileName: attachment.fileName,
    relativePath: attachment.relativePath,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    sourceWidth: attachment.sourceWidth,
    sourceHeight: attachment.sourceHeight,
    url:
      typeof attachment.url === 'string'
        ? attachment.url.startsWith('data:')
          ? `[data-url length=${attachment.url.length}]`
          : attachment.url
        : attachment.url
  }))
