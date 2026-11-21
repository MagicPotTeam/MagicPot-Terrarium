// How composer and queued attachments are kept in a form that outlives this renderer
// (FIX-PLAN item 4, part 3). A blob: URL dies with the renderer, so a draft or a queued item that
// holds one must store something else: the image is imported into managed media and the draft
// keeps the reference (a few hundred characters), not a base64 copy of the image.

import type { ChatAttachment } from '@shared/api/svcLLMProxy'
import { cloneChatAttachment } from '@renderer/features/chat/chatDraftUtils'
import { fileToDataUrl } from '@renderer/utils/fileUtils'
import { api } from '@renderer/utils/windowUtils'
import {
  importIncomingChatImageAttachment,
  withIncomingChatImageImportTimeout
} from './chatManagedMediaAttachments'
import { isOversizedInlineImageAttachment } from './chatInlineAttachmentGuard'

/**
 * blob: URL -> the import of its image. A blob's bytes never change, so one import serves the
 * draft saves that follow. Only a managed reference is kept, for a while: a result that is the
 * image itself (a data: URL, for a format the store does not hold) is dropped once it settles, so
 * this cache never holds image bytes; and a reference is imported again after
 * BLOB_IMAGE_IMPORT_REUSE_MS, which also starts the store's retention time of its file again.
 */
const blobImageImports = new Map<string, { flight: Promise<ChatAttachment>; at: number }>()
const BLOB_IMAGE_IMPORTS_MAX = 64
const BLOB_IMAGE_IMPORT_REUSE_MS = 30 * 60_000

/** The fields an attachment takes from the import of the same blob. */
const withImportedFields = (
  attachment: ChatAttachment,
  imported: ChatAttachment
): ChatAttachment => ({
  ...attachment,
  url: imported.url,
  ...(imported.media ? { media: imported.media } : {}),
  ...(imported.mimeType ? { mimeType: imported.mimeType } : {}),
  ...(typeof imported.sizeBytes === 'number' ? { sizeBytes: imported.sizeBytes } : {})
})

/**
 * A blob: image of the composer or the queue, imported into managed media (once per blob URL).
 * The result is a managed reference, or, for an image format the store does not hold, the image
 * as a data: URL. Rejects when the import fails.
 */
export const importDraftBlobImage = async (attachment: ChatAttachment): Promise<ChatAttachment> => {
  const url = attachment.url
  const now = Date.now()
  const cached = blobImageImports.get(url)
  let flight = cached && now - cached.at < BLOB_IMAGE_IMPORT_REUSE_MS ? cached.flight : undefined
  if (!flight) {
    const started = withIncomingChatImageImportTimeout(
      importIncomingChatImageAttachment(attachment, { service: api()?.svcManagedMedia })
    )
    flight = started
    const entry = { flight: started, at: now }
    blobImageImports.delete(url)
    blobImageImports.set(url, entry)
    const forget = () => {
      if (blobImageImports.get(url) === entry) blobImageImports.delete(url)
    }
    started.then((imported) => {
      if (!imported.media || imported.url.startsWith('data:')) forget()
    }, forget)
    for (const [key, held] of blobImageImports) {
      if (
        blobImageImports.size <= BLOB_IMAGE_IMPORTS_MAX &&
        now - held.at < BLOB_IMAGE_IMPORT_REUSE_MS
      )
        break
      blobImageImports.delete(key)
    }
  }
  const imported = await flight
  if (imported.url.startsWith('blob:')) throw new Error('The draft image was not imported')
  return withImportedFields(attachment, imported)
}

/** The former form of a blob: attachment in a draft: its bytes as a data: URL. */
const blobAttachmentAsDataUrl = async (attachment: ChatAttachment): Promise<ChatAttachment> => {
  const response = await fetch(attachment.url)
  if (!response.ok) throw new Error('Draft attachment could not be read')
  const blob = await response.blob()
  const file = new File([blob], attachment.fileName || 'attachment', {
    type: attachment.mimeType || blob.type || 'application/octet-stream'
  })
  return {
    ...attachment,
    url: await fileToDataUrl(file),
    mimeType: attachment.mimeType || blob.type || undefined
  }
}

/**
 * The stored form of one composer attachment. A blob: image is imported into managed media; when
 * that fails, and for other blob: attachments (video, files), the bytes are kept as a data: URL as
 * before, so a draft never loses an attachment because of the import. Null when the blob cannot be
 * read at all.
 */
export const serializeDraftAttachment = async (
  attachment: ChatAttachment
): Promise<ChatAttachment | null> => {
  if (!attachment.url.startsWith('blob:')) {
    return cloneChatAttachment(attachment)
  }
  if (attachment.type === 'image') {
    try {
      return await importDraftBlobImage(attachment)
    } catch (error) {
      console.warn('[ChatPage] Draft image kept inline; its managed import failed:', error)
    }
  }
  try {
    return await blobAttachmentAsDataUrl(attachment)
  } catch (error) {
    console.warn('[ChatPage] Failed to serialize draft attachment:', error)
    return null
  }
}

/** Every attachment of a draft in its stored form; an attachment that cannot be read is left out. */
export const serializeDraftAttachments = async (
  attachments: ChatAttachment[]
): Promise<ChatAttachment[]> => {
  const serialized: ChatAttachment[] = []
  for (const attachment of attachments) {
    const result = await serializeDraftAttachment(attachment)
    if (result) serialized.push(result)
  }
  return serialized
}

/** A queued image a stored queue cannot keep as it is: a blob: URL or an oversized inline image. */
export const needsDurableQueuedImport = (attachment: ChatAttachment | undefined): boolean =>
  attachment?.type === 'image' &&
  typeof attachment.url === 'string' &&
  (attachment.url.startsWith('blob:') || isOversizedInlineImageAttachment(attachment))

/**
 * The attachments of a queued item with every such image imported into managed media, one at a
 * time. An image whose import fails stays as it was (the stored queue then marks it unavailable,
 * as before). Resolves to the same array when nothing changed. Never rejects.
 */
export const importQueuedImages = async (
  attachments: readonly ChatAttachment[],
  importInlineImage: (attachment: ChatAttachment) => Promise<ChatAttachment>
): Promise<readonly ChatAttachment[]> => {
  if (!attachments.some(needsDurableQueuedImport)) return attachments
  const durable: ChatAttachment[] = []
  for (const attachment of attachments) {
    if (!needsDurableQueuedImport(attachment)) {
      durable.push(attachment)
      continue
    }
    try {
      durable.push(
        attachment.url.startsWith('blob:')
          ? await importDraftBlobImage(attachment)
          : await importInlineImage(attachment)
      )
    } catch (error) {
      console.warn('[ChatPage] A queued image stays as it was; its managed import failed:', error)
      durable.push(attachment)
    }
  }
  return durable.every((attachment, index) => attachment === attachments[index])
    ? attachments
    : durable
}
