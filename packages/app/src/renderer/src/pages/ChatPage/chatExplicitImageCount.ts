import { DEFAULT_CHAT_IMAGE_COUNT_LIMIT } from '@shared/llm/chatImageCountLimit'

type ExplicitAttachmentDescriptor = { readonly type: string }

// Call with the user's explicit descriptors before adding derived video frames.
// This does not inspect message history or bundle metadata.
export const assertExplicitUserImageCount = (attachments: readonly ExplicitAttachmentDescriptor[] | undefined): void => {
  let count = 0
  for (const attachment of attachments ?? []) {
    if (attachment.type === 'image' && ++count > DEFAULT_CHAT_IMAGE_COUNT_LIMIT) {
      throw new Error('本次图片数量超过限制，请分批发送')
    }
  }
}
