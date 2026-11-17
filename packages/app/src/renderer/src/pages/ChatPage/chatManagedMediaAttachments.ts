import i18next from 'i18next'
import type { ManagedMediaSvc } from '@shared/api/svcManagedMedia'
import type { ChatAttachment } from '@shared/api/svcLLMProxy'
import type { ManagedMediaStorage } from '@shared/api/svcManagedMedia'
import { MANAGED_MEDIA_IMPORT_BYTES_MAX_BYTES } from '@shared/api/svcManagedMedia'
import { normalizeMediaReference } from '@shared/mediaReference'
import { formatFileSize } from '@renderer/utils/fileUtils'
import { resolveLocalMediaPathFromUrl } from './chatPageShared'

/**
 * A File's own `path` property no longer exists in Electron 42 and, when present, is a plain
 * property any renderer code can set; it is never used as an import source.
 */
export type ManagedAttachmentFile = File & { path?: string }
type Dimensions = { sourceWidth?: number; sourceHeight?: number }

/** Chat attachments are user-owned outputs, not task scratch data. */
export const CHAT_ATTACHMENT_STORAGE = {
  namespace: 'user-output',
  scope: 'chat-attachments'
} as const satisfies ManagedMediaStorage

/** The preload's file bridge (window.electronFile), as far as attachment import uses it. */
export type ChatAttachmentFileBridge = {
  getPathForFile?: (file: File) => string
  /** One-use, in-memory import grant in main; returns the canonical path or ''. */
  authorizeLocalMediaFileForImport?: (file: File, mimeType: string) => Promise<string>
  resolveAuthorizedLocalMediaPath?: (filePath: string) => Promise<string>
}

type ImportChatAttachmentInput = {
  service?: Pick<ManagedMediaSvc, 'importFile' | 'importBytes'>
  file: ManagedAttachmentFile
  /** Defaults to window.electronFile. */
  fileBridge?: ChatAttachmentFileBridge
  type: ChatAttachment['type']
  mimeType?: string
  relativePath?: string
  dimensions?: Dimensions
  storage?: ManagedMediaStorage
}

type ImportChatAttachmentUrlInput = {
  service?: Pick<ManagedMediaSvc, 'importDataUrl' | 'importBytes'>
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

/** Largest path-less attachment (pasted or generated data) the chat reads into memory. */
export const CHAT_PATHLESS_ATTACHMENT_MAX_BYTES = MANAGED_MEDIA_IMPORT_BYTES_MAX_BYTES

/** Raised before reading path-less data above CHAT_PATHLESS_ATTACHMENT_MAX_BYTES. */
export class ChatPathlessAttachmentTooLargeError extends Error {
  constructor(
    readonly fileName: string,
    readonly sizeBytes: number,
    readonly maxBytes: number = CHAT_PATHLESS_ATTACHMENT_MAX_BYTES
  ) {
    const values = {
      fileName: fileName || 'attachment',
      size: formatFileSize(sizeBytes),
      maxMB: Math.floor(maxBytes / (1024 * 1024))
    }
    // i18next returns nothing before it is initialised: keep the numbers in that case.
    super(
      i18next.t('chat.pathless_attachment_too_large', values) ||
        `${values.fileName} (${values.size}) > ${values.maxMB} MB`
    )
    this.name = 'ChatPathlessAttachmentTooLargeError'
  }
}

/**
 * The short message the composer shows when an attachment cannot be added: the size refusal
 * for path-less data above the cap, otherwise "could not process <name>". Main's error text
 * is never shown (it is logged), so no path or internal detail reaches the message.
 */
export const describeChatAttachmentImportFailure = (
  error: unknown,
  fileName: string,
  kind: 'image' | 'file'
): string => {
  if (error instanceof ChatPathlessAttachmentTooLargeError) return error.message
  const name = fileName || 'attachment'
  return (
    i18next.t(kind === 'image' ? 'chat.image_process_failed' : 'chat.file_process_failed', {
      name
    }) || name
  )
}

/** The blob's bytes as one ArrayBuffer (FileReader only where Blob#arrayBuffer is missing). */
const readBlobArrayBuffer = (blob: Blob): Promise<ArrayBuffer> => {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer()
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as ArrayBuffer)
    reader.onerror = () => reject(reader.error || new Error('Failed to read attachment.'))
    reader.readAsArrayBuffer(blob)
  })
}

/**
 * Import path-less data (clipboard, generated blob) as bytes: one ArrayBuffer, never a base64
 * string. Data above the cap is refused before it is read.
 */
const importPathlessBlob = async (
  service: Pick<ManagedMediaSvc, 'importBytes'>,
  blob: Blob,
  {
    mimeType,
    originalFileName,
    storage
  }: { mimeType: string; originalFileName: string; storage: ManagedMediaStorage }
): Promise<Awaited<ReturnType<ManagedMediaSvc['importBytes']>>> => {
  if (blob.size > CHAT_PATHLESS_ATTACHMENT_MAX_BYTES) {
    throw new ChatPathlessAttachmentTooLargeError(originalFileName, blob.size)
  }
  return service.importBytes({
    bytes: new Uint8Array(await readBlobArrayBuffer(blob)),
    // A typeless blob is application/octet-stream, which the managed store rejects.
    mimeType: mimeType || 'application/octet-stream',
    originalFileName,
    storage
  })
}

const fetchAttachmentBlob = async (url: string): Promise<Blob> => {
  const response = await fetch(url)
  if ('ok' in response && !response.ok)
    throw new Error(`Failed to fetch attachment: ${response.status}`)
  return response.blob()
}

/** UNC (\\server\share) and Win32 device / namespace paths (\\?\, \\.\): main refuses them. */
const isNetworkOrDevicePath = (value: string): boolean => /^[\\/]{2}/u.test(value)

const defaultFileBridge = (): ChatAttachmentFileBridge | undefined =>
  typeof window === 'undefined' ? undefined : window.electronFile

/** The path the preload reports for a File the user picked or dropped, or ''. */
const readPickedFilePath = (file: File, bridge: ChatAttachmentFileBridge | undefined): string => {
  if (!bridge?.getPathForFile) return ''
  try {
    const rawPath: unknown = bridge.getPathForFile(file)
    if (typeof rawPath !== 'string') {
      // A guarded bridge answers with a (rejected) promise instead of a path.
      void Promise.resolve(rawPath).catch(() => undefined)
      return ''
    }
    return rawPath.trim()
  } catch {
    return ''
  }
}

/**
 * The canonical path main may import a picked file from, or '' when the file has no path
 * (clipboard, generated blob) or main does not grant it. The path comes only from the
 * preload's webUtils.getPathForFile, which returns a path only for a File the user picked or
 * dropped. authorizeLocalMediaFileForImport records a one-use, in-memory import grant in main
 * (never a persisted grant, so chat attachments cannot push canvas grants out), and main's
 * importFile uses it up.
 */
const resolvePickedFileImportPath = async (
  file: File,
  pickedPath: string,
  mimeType: string,
  bridge: ChatAttachmentFileBridge | undefined
): Promise<string> => {
  if (!pickedPath || isNetworkOrDevicePath(pickedPath)) return ''
  if (!bridge?.authorizeLocalMediaFileForImport) return ''
  try {
    const canonicalPath = String(
      (await bridge.authorizeLocalMediaFileForImport(file, mimeType)) || ''
    ).trim()
    return canonicalPath && !isNetworkOrDevicePath(canonicalPath) ? canonicalPath : ''
  } catch {
    return ''
  }
}

export const importChatAttachment = async ({
  service,
  file,
  fileBridge = defaultFileBridge(),
  type,
  mimeType,
  relativePath,
  dimensions,
  storage = CHAT_ATTACHMENT_STORAGE
}: ImportChatAttachmentInput): Promise<ChatAttachment> => {
  if (!service) throw new Error('Managed media service is unavailable')
  const originalFileName = file.name || 'attachment'
  const importMimeType = mimeType || file.type
  const pickedPath = readPickedFilePath(file, fileBridge)
  // A file on disk whose type the store does not hold (video, 3D model): main refuses the
  // type before it looks at the path, so no grant is asked for and the file is never read.
  const grantable =
    !pickedPath || isNetworkOrDevicePath(pickedPath) || isStoreMimeType(importMimeType)
  // A file on disk is copied by main from its path: its bytes never enter the renderer.
  const sourcePath = grantable
    ? await resolvePickedFileImportPath(file, pickedPath, importMimeType, fileBridge)
    : pickedPath
  const imported = sourcePath
    ? await service.importFile({
        sourcePath,
        mimeType: importMimeType,
        originalFileName,
        storage
      })
    : await importPathlessBlob(service, file, {
        mimeType: importMimeType,
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
  // A data: URL is already a string: it is sent as it is. A blob: URL is sent as bytes.
  const imported = url.startsWith('data:')
    ? await service.importDataUrl({ dataUrl: url, originalFileName: fileName, storage })
    : await (async () => {
        const blob = await fetchAttachmentBlob(url)
        return importPathlessBlob(service, blob, {
          mimeType: blob.type,
          originalFileName: fileName,
          storage
        })
      })()
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

/** The store's own type rule (main's isManagedMediaMimeTypeSupported): no jpg alias. */
const isStoreMimeType = (value: string): boolean =>
  MANAGED_IMAGE_MIME_TYPES.has(String(value || '').split(';', 1)[0].trim().toLowerCase())

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
  service?: Pick<ManagedMediaSvc, 'importFile' | 'importDataUrl' | 'importBytes'>
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
 * - blob: read once as bytes and imported; the blob URL is never kept.
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

  // For a file source the file's own extension says more about its bytes than the
  // attachment's display name or declared type (a pasted-image.png label on a .jpg file,
  // a bounded webp copy that kept its .png display name); main checks the bytes anyway.
  const declaredMime =
    (localPath ? imageMimeTypeFromName(localPath) : '') ||
    normalizeImageMimeType(attachment.mimeType) ||
    (isData ? dataUrlMimeType(url) : '') ||
    imageMimeTypeFromName(attachment.fileName)
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
      if (blob.size > CHAT_PATHLESS_ATTACHMENT_MAX_BYTES) {
        throw new ChatPathlessAttachmentTooLargeError(originalFileName, blob.size)
      }
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
      await importPathlessBlob(service, blob, {
        mimeType: effectiveMime,
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

/** Longest one incoming image may take to be imported (and bounded) before it is refused. */
export const INCOMING_CHAT_IMAGE_IMPORT_TIMEOUT_MS = 60_000

/**
 * Reject when `work` has not settled within `timeoutMs`, so an import that hangs (a file
 * on an unreachable share, a stuck worker) ends in the caller's error path instead of
 * blocking every later hand-off. The late result of `work` is ignored.
 */
export const withIncomingChatImageImportTimeout = <T>(
  work: Promise<T>,
  timeoutMs: number = INCOMING_CHAT_IMAGE_IMPORT_TIMEOUT_MS
): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Incoming image import did not finish within ${timeoutMs} ms`)),
      timeoutMs
    )
    work.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })

/** Raised when an incoming image is above the per-image limit and cannot be reduced. */
export class ChatImageTooLargeError extends Error {
  constructor(
    readonly fileName: string,
    readonly sizeBytes: number,
    readonly maxBytes: number
  ) {
    super(`${fileName || 'image'} is larger than the ${maxBytes} byte image attachment limit`)
    this.name = 'ChatImageTooLargeError'
  }
}

export type BoundedChatImageAttachment = {
  attachment: ChatAttachment
  /** Set when the attachment was replaced by a smaller managed derivative. */
  downscaled?: { width: number; height: number; originalSizeBytes: number }
}

const DOWNSCALE_MAX_EDGES = [2048, 1024, 512] as const

/**
 * Apply the composer's per-image byte limit to an image that did not come through the
 * composer. A managed image above the limit is replaced by the store's own bounded
 * derivative (2048 px, then 1024 px, then 512 px: the first that fits), imported as a
 * managed original of its own so the request sends the smaller bytes. An image that
 * cannot be reduced (no derivative, animated GIF, not managed) is refused with
 * ChatImageTooLargeError, which is what the composer does for a file above the limit.
 */
export const boundIncomingChatImageSize = async (
  attachment: ChatAttachment,
  {
    service,
    maxBytes,
    fetchImpl = (input) => fetch(input),
    storage = CHAT_ATTACHMENT_STORAGE
  }: {
    service?: Partial<Pick<ManagedMediaSvc, 'ensureDerivative' | 'importBytes'>>
    maxBytes: number
    fetchImpl?: typeof fetch
    storage?: ManagedMediaStorage
  }
): Promise<BoundedChatImageAttachment> => {
  if (attachment.type !== 'image') return { attachment }
  const reference = normalizeMediaReference(attachment.media)
  const managed = reference?.kind === 'managed' ? reference : undefined
  const sizeBytes = managed?.sizeBytes ?? attachment.sizeBytes ?? 0
  if (sizeBytes <= maxBytes) return { attachment }
  const fileName = attachment.fileName || managed?.originalFileName || 'image'
  const tooLarge = () => new ChatImageTooLargeError(fileName, sizeBytes, maxBytes)
  if (!managed || !service?.ensureDerivative || !service.importBytes) throw tooLarge()
  const bytesService = { importBytes: service.importBytes.bind(service) }

  for (const maxEdge of DOWNSCALE_MAX_EDGES) {
    let derivative: Awaited<ReturnType<ManagedMediaSvc['ensureDerivative']>>
    try {
      derivative = await service.ensureDerivative({ reference: managed, maxEdge })
    } catch (error) {
      console.warn('[chatManagedMediaAttachments] Bounded derivative unavailable:', error)
      throw tooLarge()
    }
    if (derivative.status !== 'ready') throw tooLarge()
    const descriptor = derivative.descriptor
    if (descriptor.sizeBytes > maxBytes) continue
    const blob = await fetchImageBlob(descriptor.localMediaUrl, fetchImpl)
    const imported = await importPathlessBlob(bytesService, blob, {
      mimeType: descriptor.mimeType,
      originalFileName: toManagedOriginalFileName(fileName, 'image'),
      storage
    })
    return {
      attachment: {
        ...attachment,
        url: imported.localMediaUrl,
        media: imported.reference,
        mimeType: imported.reference.mimeType || descriptor.mimeType,
        sizeBytes: imported.reference.sizeBytes ?? descriptor.sizeBytes,
        sourceWidth: descriptor.width,
        sourceHeight: descriptor.height
      },
      downscaled: {
        width: descriptor.width,
        height: descriptor.height,
        originalSizeBytes: sizeBytes
      }
    }
  }
  throw tooLarge()
}
