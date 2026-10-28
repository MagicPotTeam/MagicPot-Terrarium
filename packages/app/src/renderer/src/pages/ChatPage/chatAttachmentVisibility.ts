import type { ChatAttachment } from '../QuickAppPage/QAppExecutePanel/qAppExecuteInputs/api/LLM'

export function isChatAttachmentVisibleInChatView(
  attachment: ChatAttachment | null | undefined
): attachment is ChatAttachment {
  return Boolean(attachment && attachment.hiddenFromChatView !== true)
}

export function getVisibleChatAttachments(
  attachments: ChatAttachment[] | undefined
): ChatAttachment[] {
  return attachments?.filter(isChatAttachmentVisibleInChatView) || []
}

export function getVisibleChatAttachmentEntries(attachments: ChatAttachment[] | undefined): Array<{
  attachment: ChatAttachment
  originalIndex: number
}> {
  return (attachments || []).flatMap((attachment, originalIndex) =>
    isChatAttachmentVisibleInChatView(attachment) ? [{ attachment, originalIndex }] : []
  )
}

/**
 * Build keys from an attachment's source rather than its position. Attachment arrays can be
 * reordered while a message or draft is being persisted; index keys would then reuse an image
 * component (and its in-flight load/error state) for a different source.
 */
export function getChatAttachmentRenderKeys(attachments: ChatAttachment[]): string[] {
  const occurrences = new Map<string, number>()
  return attachments.map((attachment) => {
    const media = attachment.media
    const mediaIdentity =
      media?.kind === 'managed'
        ? `managed:${media.version ?? ''}:${media.relativePath ?? ''}:${media.sha256 ?? ''}`
        : ''
    const identity = JSON.stringify([attachment.type, attachment.url, mediaIdentity])
    const occurrence = occurrences.get(identity) ?? 0
    occurrences.set(identity, occurrence + 1)
    return `chat-attachment:${identity}:${occurrence}`
  })
}
