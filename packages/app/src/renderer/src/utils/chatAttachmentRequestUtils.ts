import type { ChatAttachment } from '@shared/llm'
import { normalizeLocalMediaUrl } from '@renderer/pages/ChatPage/chatPageShared'

const blobToDataUrl = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(reader.error || new Error('Failed to read blob as data URL'))
    reader.readAsDataURL(blob)
  })

const normalizeImageAttachmentForRequest = async (
  attachment: ChatAttachment
): Promise<ChatAttachment> => {
  if (attachment.type !== 'image' || !attachment.url || attachment.url.startsWith('data:')) {
    return attachment
  }

  try {
    const response = await fetch(normalizeLocalMediaUrl(attachment.url))
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
    console.warn(
      '[AttachmentRequestUtils] Failed to normalize image attachment for request:',
      attachment.fileName || attachment.url,
      error
    )
    return attachment
  }
}

export const normalizeChatAttachmentsForRequest = async (
  attachments: ChatAttachment[] | undefined
): Promise<ChatAttachment[] | undefined> => {
  if (!attachments?.length) {
    return undefined
  }

  return Promise.all(
    attachments.map((attachment) =>
      attachment.type === 'image'
        ? normalizeImageAttachmentForRequest(attachment)
        : Promise.resolve(attachment)
    )
  )
}
