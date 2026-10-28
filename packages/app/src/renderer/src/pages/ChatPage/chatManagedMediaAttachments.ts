import type { ManagedMediaSvc } from '@shared/api/svcManagedMedia'
import type { ChatAttachment } from '@shared/api/svcLLMProxy'
import type { ManagedMediaStorage } from '@shared/api/svcManagedMedia'

export type ManagedAttachmentFile = File & { path?: string }
type Dimensions = { sourceWidth?: number; sourceHeight?: number }

/** Chat attachments are user-owned outputs, not task scratch data. */
export const CHAT_ATTACHMENT_STORAGE = {
  namespace: 'user-output',
  scope: 'chat-attachments'
} as const satisfies ManagedMediaStorage

type ImportChatAttachmentInput = {
  service?: Pick<ManagedMediaSvc, 'importFile' | 'importDataUrl'>
  file: ManagedAttachmentFile
  type: ChatAttachment['type']
  mimeType?: string
  relativePath?: string
  dimensions?: Dimensions
  storage?: ManagedMediaStorage
}

type ImportChatAttachmentUrlInput = {
  service?: Pick<ManagedMediaSvc, 'importDataUrl'>
  url: string
  fileName: string
  dimensions?: Dimensions
  storage?: ManagedMediaStorage
}

const readFileAsDataUrl = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(reader.error || new Error('Failed to read attachment.'))
    reader.readAsDataURL(file)
  })

const readUrlAsDataUrl = async (url: string): Promise<string> => {
  if (url.startsWith('data:')) return url
  const response = await fetch(url)
  if ('ok' in response && !response.ok)
    throw new Error(`Failed to fetch attachment: ${response.status}`)
  return readFileAsDataUrl(new File([await response.blob()], 'attachment'))
}

export const importChatAttachment = async ({
  service,
  file,
  type,
  mimeType,
  relativePath,
  dimensions,
  storage = CHAT_ATTACHMENT_STORAGE
}: ImportChatAttachmentInput): Promise<ChatAttachment> => {
  if (!service) throw new Error('Managed media service is unavailable')
  const originalFileName = file.name || 'attachment'
  const sourcePath = typeof file.path === 'string' ? file.path.trim() : ''
  const imported = sourcePath
    ? await service.importFile({
        sourcePath,
        mimeType: mimeType || file.type,
        originalFileName,
        storage
      })
    : await service.importDataUrl({
        dataUrl: await readFileAsDataUrl(file),
        originalFileName,
        storage
      })
  return {
    type,
    url: imported.localMediaUrl,
    mimeType: mimeType || file.type,
    fileName: originalFileName,
    media: imported.reference,
    sizeBytes: file.size,
    relativePath,
    ...dimensions
  }
}

export const importChatAttachmentUrl = async ({
  service,
  url,
  fileName,
  dimensions,
  storage = CHAT_ATTACHMENT_STORAGE
}: ImportChatAttachmentUrlInput): Promise<ChatAttachment> => {
  if (!service) throw new Error('Managed media service is unavailable')
  if (!url.startsWith('data:') && !url.startsWith('blob:')) {
    return { type: 'image', url, fileName, ...dimensions }
  }
  const imported = await service.importDataUrl({
    dataUrl: await readUrlAsDataUrl(url),
    originalFileName: fileName,
    storage
  })
  return {
    type: 'image',
    url: imported.localMediaUrl,
    mimeType: url.startsWith('data:') ? url.slice(5, url.indexOf(';')) || undefined : undefined,
    fileName,
    media: imported.reference,
    ...dimensions
  }
}
