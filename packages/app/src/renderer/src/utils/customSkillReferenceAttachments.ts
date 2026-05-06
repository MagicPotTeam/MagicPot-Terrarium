import type { SkillReferenceAttachment } from '@shared/config/config'
import type { ChatAttachment } from '@shared/api/svcLLMProxy'
import { fileToDataUrl } from './fileUtils'
import { normalizeFileMimeType } from './fileDisplay'

const WINDOWS_DRIVE_PATH_RE = /^[a-z]:\//i

type LocalPathFile = File & {
  path?: string
}

export const getLocalFilePathFromFile = (file: File): string => {
  const localPath = (file as LocalPathFile).path
  return typeof localPath === 'string' ? localPath.replace(/\\/g, '/') : ''
}

export const toLocalFileUrl = (localPath: string): string => {
  const normalizedPath = localPath.replace(/\\/g, '/')
  if (WINDOWS_DRIVE_PATH_RE.test(normalizedPath)) {
    return `file:///${normalizedPath}`
  }
  return normalizedPath.startsWith('/') ? `file://${normalizedPath}` : `file://${normalizedPath}`
}

export const buildSkillReferenceAttachmentKey = (
  attachment:
    | Pick<SkillReferenceAttachment, 'type' | 'url' | 'fileName' | 'mimeType' | 'relativePath'>
    | Pick<ChatAttachment, 'type' | 'url' | 'fileName' | 'mimeType' | 'relativePath'>
): string =>
  [
    attachment.type,
    attachment.url || '',
    attachment.fileName || '',
    attachment.mimeType || '',
    attachment.relativePath || ''
  ].join('::')

export const dedupeSkillReferenceAttachments = (
  attachments: SkillReferenceAttachment[] | undefined
): SkillReferenceAttachment[] => {
  if (!attachments || attachments.length === 0) {
    return []
  }

  const seenKeys = new Set<string>()
  return attachments.filter((attachment) => {
    const key = buildSkillReferenceAttachmentKey(attachment)
    if (seenKeys.has(key)) {
      return false
    }
    seenKeys.add(key)
    return true
  })
}

export const buildSkillReferenceAttachmentFromFile = async (
  file: File
): Promise<SkillReferenceAttachment> => {
  const mimeType = normalizeFileMimeType(file.name, file.type)
  const localPath = getLocalFilePathFromFile(file)

  return {
    type: mimeType.startsWith('image/') ? 'image' : 'file',
    url: localPath ? toLocalFileUrl(localPath) : await fileToDataUrl(file),
    mimeType,
    fileName: file.name,
    sizeBytes: file.size
  }
}

export const toChatAttachmentFromSkillReference = (
  attachment: SkillReferenceAttachment
): ChatAttachment => ({
  ...attachment,
  hiddenFromChatView: true
})

export const mergeChatAttachmentsWithSkillReferenceAttachments = (
  attachments: ChatAttachment[] | undefined,
  referenceAttachments: SkillReferenceAttachment[] | undefined
): ChatAttachment[] | undefined => {
  const mergedAttachments: ChatAttachment[] = []
  const seenKeys = new Set<string>()

  ;(attachments || []).forEach((attachment) => {
    const key = buildSkillReferenceAttachmentKey(attachment)
    if (seenKeys.has(key)) return
    seenKeys.add(key)
    mergedAttachments.push(attachment)
  })

  dedupeSkillReferenceAttachments(referenceAttachments).forEach((attachment) => {
    const key = buildSkillReferenceAttachmentKey(attachment)
    if (seenKeys.has(key)) return
    seenKeys.add(key)
    mergedAttachments.push(toChatAttachmentFromSkillReference(attachment))
  })

  return mergedAttachments.length > 0 ? mergedAttachments : undefined
}
