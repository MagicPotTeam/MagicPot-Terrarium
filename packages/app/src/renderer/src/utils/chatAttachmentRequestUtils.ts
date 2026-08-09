import type { ChatAttachment } from '@shared/llm'
import { normalizeLocalMediaUrl } from '@renderer/pages/ChatPage/chatPageShared'
import {
  resolveChatAttachmentSource,
  type ResolveChatAttachmentSourceOptions
} from '@renderer/features/chat/chatAttachmentUtils'

const blobToDataUrl = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(reader.error || new Error('Failed to read blob as data URL'))
    reader.readAsDataURL(blob)
  })

const normalizeImageAttachmentForRequest = async (
  attachment: ChatAttachment,
  options: ResolveChatAttachmentSourceOptions
): Promise<ChatAttachment> => {
  const resolvedSource = resolveChatAttachmentSource(attachment, options)
  if (resolvedSource.status === 'unavailable') {
    throw new Error(
      `Unable to prepare image attachment "${attachment.fileName || 'image'}" for the model: attachment media source is unavailable (${resolvedSource.reason})`
    )
  }
  const sourceUrl = resolvedSource.url

  if (attachment.type !== 'image' || !sourceUrl || sourceUrl.startsWith('data:')) {
    return sourceUrl === attachment.url ? attachment : { ...attachment, url: sourceUrl }
  }

  try {
    const response = await fetch(normalizeLocalMediaUrl(sourceUrl))
    if (!response.ok) {
      throw new Error(`Failed to load image attachment (${response.status})`)
    }

    const blob =
      typeof response.blob === 'function'
        ? await response.blob()
        : new Blob([await response.arrayBuffer()], {
            type: attachment.mimeType || 'image/png'
          })
    const dataUrl = await blobToDataUrl(blob)

    return {
      ...attachment,
      url: dataUrl,
      mimeType: attachment.mimeType || blob.type || 'image/png',
      sizeBytes:
        typeof attachment.sizeBytes === 'number' && Number.isFinite(attachment.sizeBytes)
          ? attachment.sizeBytes
          : blob.size
    }
  } catch (error) {
    if (resolvedSource.source === 'media') {
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(
        `Unable to prepare image attachment "${attachment.fileName || 'image'}" for the model: ${reason}`
      )
    }
    console.warn(
      '[AttachmentRequestUtils] Failed to normalize image attachment for request:',
      attachment.fileName || attachment.url,
      error
    )
    return attachment
  }
}

export const normalizeChatAttachmentsForRequest = async (
  attachments: ChatAttachment[] | undefined,
  options: ResolveChatAttachmentSourceOptions = {}
): Promise<ChatAttachment[] | undefined> => {
  if (!attachments?.length) {
    return undefined
  }

  return Promise.all(
    attachments.map((attachment) =>
      attachment.type === 'image'
        ? normalizeImageAttachmentForRequest(attachment, options)
        : Promise.resolve(attachment)
    )
  )
}
