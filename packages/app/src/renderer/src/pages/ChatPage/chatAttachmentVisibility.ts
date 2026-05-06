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
