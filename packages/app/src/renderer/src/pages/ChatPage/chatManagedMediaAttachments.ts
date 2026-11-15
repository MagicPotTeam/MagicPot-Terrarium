import type { ManagedMediaSvc } from '@shared/api/svcManagedMedia'
import type { ChatAttachment } from '@shared/api/svcLLMProxy'
import type { ManagedMediaStorage } from '@shared/api/svcManagedMedia'
import { normalizeMediaReference } from '@shared/mediaReference'
import { resolveLocalMediaPathFromUrl } from './chatPageShared'

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
  const blob = await response.blob()
  // Keep the blob's type: a typeless File would encode as application/octet-stream,
  // which the managed store rejects.
  return readFileAsDataUrl(new File([blob], 'attachment', { type: blob.type }))
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

/** MIME types the managed media store accepts (main validates the bytes against them). */
const MANAGED_IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif'
}

const normalizeImageMimeType = (value?: string | null): string => {
  const mime = String(value || '')
    .split(';', 1)[0]
    .trim()
    .toLowerCase()
  return mime === 'image/jpg' ? 'image/jpeg' : mime
}

const imageMimeTypeFromName = (name?: string): string => {
  const match = /\.([a-z0-9]+)$/i.exec(String(name || '').trim())
  return match ? IMAGE_MIME_BY_EXTENSION[match[1].toLowerCase()] || '' : ''
}

const dataUrlMimeType = (url: string): string =>
  normalizeImageMimeType(url.slice(5, Math.max(5, url.search(/[;,]/))))

const isManagedImageMimeType = (mime: string): boolean => MANAGED_IMAGE_MIME_TYPES.has(mime)

/** The store's file-name rule; the attachment keeps its own display name. */
const toManagedOriginalFileName = (fileName: string | undefined, fallback: string): string => {
  const cleaned = String(fileName || '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '_')
    .replace(/[. ]+$/u, '')
    .slice(0, 255)
  if (!cleaned || cleaned === '.' || cleaned === '..') return fallback
  return /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu.test(cleaned) ? `_${cleaned}` : cleaned
}

const blobToTypedDataUrl = (blob: Blob, mimeType: string): Promise<string> =>
  readFileAsDataUrl(new File([blob], 'attachment', { type: mimeType }))

const defaultResolveAuthorizedLocalPath = async (filePath: string): Promise<string> => {
  if (typeof window === 'undefined') return ''
  try {
    return (await window.electronFile?.resolveAuthorizedLocalMediaPath?.(filePath)) || ''
  } catch {
    return ''
  }
}

export type IncomingChatImageImportOptions = {
  service?: Pick<ManagedMediaSvc, 'importFile' | 'importDataUrl'>
  /** Main-side local-media authorisation; returns the canonical path or ''. */
  resolveAuthorizedLocalPath?: (filePath: string) => Promise<string>
  fetchImpl?: typeof fetch
  storage?: ManagedMediaStorage
}

const fetchImageBlob = async (url: string, fetchImpl: typeof fetch): Promise<Blob> => {
  const response = await fetchImpl(url)
  if ('ok' in response && !response.ok) {
    throw new Error(`Failed to read incoming image: ${response.status}`)
  }
  const blob = await response.blob()
  if (!blob.size) throw new Error('Incoming image is empty')
  return blob
}

const hasManagedReference = (attachment: ChatAttachment): boolean =>
  normalizeMediaReference(attachment.media)?.kind === 'managed'

/**
 * Turn an image attachment that arrives from outside the composer (canvas "send to
 * Agent", the 'send-to-agent' event, an internal drag) into the same managed form the
 * composer's file chooser produces: a local-media URL plus a managed media reference.
 *
 * - local-media / file: imported by path in main after the local-media authorisation;
 *   no image bytes pass through the renderer. A path main does not authorise is
 *   returned unchanged (as before; the protocol refuses it as well).
 * - blob: read once and imported; the blob URL is never kept.
 * - data: imported as it is.
 *
 * Every other field (hiddenFromChatView, fileName, dimensions, metadata, ...) is kept.
 * Attachments that are already managed, non-image attachments, remote URLs and image
 * formats the managed store cannot hold are returned unchanged, except that a blob: URL
 * of such a format becomes a data: URL so it cannot be revoked under the composer.
 * Any failure rejects; callers report it and must not drop the attachment silently.
 */
export const importIncomingChatImageAttachment = async (
  attachment: ChatAttachment,
  {
    service,
    resolveAuthorizedLocalPath = defaultResolveAuthorizedLocalPath,
    fetchImpl = (input) => fetch(input),
    storage = CHAT_ATTACHMENT_STORAGE
  }: IncomingChatImageImportOptions = {}
): Promise<ChatAttachment> => {
  if (attachment.type !== 'image') return attachment
  const url = String(attachment.url || '').trim()
  const isData = url.startsWith('data:')
  const isBlob = url.startsWith('blob:')
  if (hasManagedReference(attachment) && !isData && !isBlob) return attachment
  const localPath = isData || isBlob ? null : resolveLocalMediaPathFromUrl(url)
  if (!isData && !isBlob && !localPath) return attachment

  const declaredMime =
    normalizeImageMimeType(attachment.mimeType) ||
    (isData ? dataUrlMimeType(url) : '') ||
    imageMimeTypeFromName(attachment.fileName) ||
    (localPath ? imageMimeTypeFromName(localPath) : '')
  const originalFileName = toManagedOriginalFileName(
    attachment.fileName || (localPath ? localPath.split(/[\\/]/).filter(Boolean).pop() : undefined),
    'image'
  )
  const toManaged = (imported: Awaited<ReturnType<ManagedMediaSvc['importFile']>>) => {
    const reference = imported.reference
    return {
      ...attachment,
      url: imported.localMediaUrl,
      media: reference,
      mimeType: reference.mimeType || declaredMime || attachment.mimeType,
      sizeBytes: reference.sizeBytes ?? attachment.sizeBytes
    } satisfies ChatAttachment
  }
  const importBlob = async (blob: Blob): Promise<ChatAttachment> => {
    const blobMime = normalizeImageMimeType(blob.type)
    const effectiveMime = isManagedImageMimeType(blobMime)
      ? blobMime
      : isManagedImageMimeType(declaredMime)
        ? declaredMime
        : blobMime.startsWith('image/')
          ? blobMime
          : declaredMime
    if (!isManagedImageMimeType(effectiveMime)) {
      // Not a format the store holds: keep today's inline form for blob sources.
      if (!isBlob) return attachment
      const dataUrl = await blobToTypedDataUrl(blob, effectiveMime || 'image/png')
      return {
        ...attachment,
        url: dataUrl,
        mimeType: effectiveMime || attachment.mimeType,
        sizeBytes: blob.size
      }
    }
    if (!service) throw new Error('Managed media service is unavailable')
    return toManaged(
      await service.importDataUrl({
        dataUrl: await blobToTypedDataUrl(blob, effectiveMime),
        originalFileName,
        storage
      })
    )
  }

  if (isData) {
    if (!isManagedImageMimeType(dataUrlMimeType(url))) return attachment
    if (!service) throw new Error('Managed media service is unavailable')
    return toManaged(await service.importDataUrl({ dataUrl: url, originalFileName, storage }))
  }
  if (isBlob) return importBlob(await fetchImageBlob(url, fetchImpl))

  if (!isManagedImageMimeType(declaredMime)) return attachment
  const authorizedPath = await resolveAuthorizedLocalPath(localPath!)
  // A path main does not authorise is left as it is: the local-media protocol
  // refuses it too, so reading it here could only fail or widen access.
  if (!authorizedPath) return attachment
  if (!service) throw new Error('Managed media service is unavailable')
  return toManaged(
    await service.importFile({
      sourcePath: authorizedPath,
      mimeType: declaredMime,
      originalFileName,
      storage
    })
  )
}
