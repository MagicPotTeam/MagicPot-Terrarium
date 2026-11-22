import i18next from 'i18next'
import { DEFAULT_CHAT_IMAGE_COUNT_LIMIT } from '@shared/llm/chatImageCountLimit'

type ExplicitAttachmentDescriptor = { readonly type: string }

// Call with the user's explicit descriptors before adding derived video frames.
// This does not inspect message history or bundle metadata.
export const assertExplicitUserImageCount = (
  attachments: readonly ExplicitAttachmentDescriptor[] | undefined
): void => {
  let count = 0
  for (const attachment of attachments ?? []) {
    if (attachment.type === 'image' && ++count > DEFAULT_CHAT_IMAGE_COUNT_LIMIT) {
      throw new Error(
        i18next.t('chat.image_count_over_limit') ||
          'Too many images in this message; send them in batches'
      )
    }
  }
}
