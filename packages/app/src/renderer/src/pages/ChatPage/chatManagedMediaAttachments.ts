import i18next from 'i18next'
import type { ManagedMediaSvc } from '@shared/api/svcManagedMedia'
import type { ChatAttachment, ChatMessage } from '@shared/api/svcLLMProxy'
import type { ManagedMediaStorage } from '@shared/api/svcManagedMedia'
import {
  MANAGED_MEDIA_IMPORT_BYTES_MAX_BYTES,
  MANAGED_MEDIA_IMPORT_GRANT_WAIT_MS,
  MANAGED_MEDIA_IMPORT_TIMEOUT_MESSAGE
} from '@shared/api/svcManagedMedia'
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
  /** One-use, in-memory import grant in main: the canonical path, or why there is none. */
  authorizeLocalMediaFileForImport?: (
    file: File,
    mimeType: string
  ) => Promise<{ path?: string; refused?: 'timeout' | 'network' | 'denied' }>
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

/** A picked file whose location did not answer within main's deadline. */
export class ChatAttachmentSourceTimeoutError extends Error {
  constructor(readonly fileName: string) {
    super(
      i18next.t('chat.attachment_source_timeout', { name: fileName || 'attachment' }) ||
        `${fileName || 'attachment'}: no answer in time`
    )
    this.name = 'ChatAttachmentSourceTimeoutError'
  }
}

/** main refused the import grant of a picked file: nothing is read in its place. */
export class ChatAttachmentSourceRefusedError extends Error {
  constructor(readonly fileName: string) {
    super('The picked file was not granted for import')
    this.name = 'ChatAttachmentSourceRefusedError'
  }
}

const isSourceTimeout = (error: unknown): boolean =>
  error instanceof ChatAttachmentSourceTimeoutError ||
  String((error as { message?: unknown } | null)?.message ?? '').includes(
    MANAGED_MEDIA_IMPORT_TIMEOUT_MESSAGE
  )

/**
 * The short message the composer shows when an attachment cannot be added: the size refusal
 * for path-less data above the cap, "<name> did not respond in time" when its location
 * stalled, otherwise "could not process <name>". Main's error text is never shown (it is
 * logged), so no path or internal detail reaches the message.
 */
export const describeChatAttachmentImportFailure = (
  error: unknown,
  fileName: string,
  kind: 'image' | 'file'
): string => {
  if (error instanceof ChatPathlessAttachmentTooLargeError) return error.message
  if (isSourceTimeout(error)) return new ChatAttachmentSourceTimeoutError(fileName).message
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
    displayName = originalFileName,
    storage
  }: {
    mimeType: string
    originalFileName: string
    /** The name the user knows, for the refusal; defaults to originalFileName. */
    displayName?: string
    storage: ManagedMediaStorage
  }
): Promise<Awaited<ReturnType<ManagedMediaSvc['importBytes']>>> => {
  if (blob.size > CHAT_PATHLESS_ATTACHMENT_MAX_BYTES) {
    throw new ChatPathlessAttachmentTooLargeError(displayName, blob.size)
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
 * Where a picked file is imported from. The path comes only from the preload's
 * webUtils.getPathForFile, which returns a path only for a File the user picked or dropped;
 * authorizeLocalMediaFileForImport records a one-use, in-memory import grant in main (never a
 * persisted grant, so chat attachments cannot push canvas grants out) and main's importFile
 * spends it. Without a path (clipboard, generated blob), on a UNC path, or when the file's
 * canonical form is a network path main does not import by path (a mapped drive), the bytes
 * are read here (up to the cap). When main refuses the grant or the file does not answer in
 * time, nothing is read here: the attachment is refused.
 */
type PickedFileImportSource =
  { kind: 'path'; sourcePath: string } | { kind: 'bytes' } | { kind: 'refused'; timedOut: boolean }

const resolvePickedFileImportSource = async (
  file: File,
  pickedPath: string,
  mimeType: string,
  bridge: ChatAttachmentFileBridge | undefined
): Promise<PickedFileImportSource> => {
  if (!pickedPath || isNetworkOrDevicePath(pickedPath)) return { kind: 'bytes' }
  if (!bridge?.authorizeLocalMediaFileForImport) return { kind: 'bytes' }
  let answer: Awaited<
    ReturnType<NonNullable<ChatAttachmentFileBridge['authorizeLocalMediaFileForImport']>>
  >
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    // main always answers in time; this bound only keeps the composer from waiting forever.
    answer = await Promise.race([
      bridge.authorizeLocalMediaFileForImport(file, mimeType),
      new Promise<{ refused: 'timeout' }>((resolve) => {
        timer = setTimeout(
          () => resolve({ refused: 'timeout' }),
          MANAGED_MEDIA_IMPORT_GRANT_WAIT_MS
        )
      })
    ])
  } catch {
    return { kind: 'refused', timedOut: false }
  } finally {
    clearTimeout(timer)
  }
  const canonicalPath = typeof answer?.path === 'string' ? answer.path.trim() : ''
  if (canonicalPath && !isNetworkOrDevicePath(canonicalPath)) {
    return { kind: 'path', sourcePath: canonicalPath }
  }
  if (answer?.refused === 'network') return { kind: 'bytes' }
  return { kind: 'refused', timedOut: answer?.refused === 'timeout' }
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
  const displayName = file.name || 'attachment'
  // The name main stores under its own rule; the attachment keeps the file's name.
  const originalFileName = toManagedOriginalFileName(file.name, 'attachment')
  const importMimeType = mimeType || file.type
  const pickedPath = readPickedFilePath(file, fileBridge)
  // A file on disk whose type the store does not hold (video, 3D model): main refuses the
  // type before it looks at the path, so no grant is asked for and the file is never read.
  const grantable =
    !pickedPath || isNetworkOrDevicePath(pickedPath) || isStoreMimeType(importMimeType)
  // A file on disk is copied by main from its path: its bytes never enter the renderer.
  const source: PickedFileImportSource = grantable
    ? await resolvePickedFileImportSource(file, pickedPath, importMimeType, fileBridge)
    : { kind: 'path', sourcePath: pickedPath }
  if (source.kind === 'refused') {
    throw source.timedOut
      ? new ChatAttachmentSourceTimeoutError(displayName)
      : new ChatAttachmentSourceRefusedError(displayName)
  }
  const sourcePath = source.kind === 'path' ? source.sourcePath : ''
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
        displayName,
        storage
      })
  return {
    type,
    url: imported.localMediaUrl,
    mimeType: mimeType || file.type,
    fileName: displayName,
    media: imported.reference,
    sizeBytes: file.size,
    relativePath,
    ...dimensions
  }
}

/**
 * Import an image main granted for one import by its path (a URL-only drop): main copies it,
 * no bytes enter the renderer. `maxBytes` is checked again on the size main copied, since the
 * file may have grown after the grant.
 */
export const importChatImageFromGrantedPath = async ({
  service,
  sourcePath,
  mimeType,
  fileName,
  maxBytes,
  storage = CHAT_ATTACHMENT_STORAGE
}: {
  service?: Pick<ManagedMediaSvc, 'importFile'>
  sourcePath: string
  mimeType: string
  fileName: string
  maxBytes: number
  storage?: ManagedMediaStorage
}): Promise<ChatAttachment> => {
  if (!service) throw new Error('Managed media service is unavailable')
  const imported = await service.importFile({
    sourcePath,
    mimeType,
    originalFileName: toManagedOriginalFileName(fileName, 'image'),
    storage
  })
  const sizeBytes = imported.reference.sizeBytes
  if (!(typeof sizeBytes === 'number' && sizeBytes > 0 && sizeBytes <= maxBytes)) {
    throw new Error('Dropped image exceeds the attachment size limit')
  }
  return {
    type: 'image',
    url: imported.localMediaUrl,
    mimeType,
    fileName,
    media: imported.reference,
    sizeBytes
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
  const originalFileName = toManagedOriginalFileName(fileName, 'image')
  const imported = url.startsWith('data:')
    ? await service.importDataUrl({ dataUrl: url, originalFileName, storage })
    : await (async () => {
        const blob = await fetchAttachmentBlob(url)
        return importPathlessBlob(service, blob, {
          mimeType: blob.type,
          originalFileName,
          displayName: fileName,
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

const MANAGED_ORIGINAL_FILE_NAME_MAX_UTF8_BYTES = 255
const utf8Length = (value: string): number => new TextEncoder().encode(value).length

/**
 * The name main stores with a managed copy, under the store's file-name rule (no control or
 * reserved characters, no trailing dot or space, no device name, at most 255 UTF-8 bytes
 * with the extension kept). Names a file system allows but the store does not ('what is
 * this?.png', 'A:B test.png' from macOS) are changed, not refused; the attachment keeps its
 * own display name.
 */
export const toManagedOriginalFileName = (
  fileName: string | undefined,
  fallback: string
): string => {
  let cleaned = String(fileName || '')
    .normalize('NFC')
    .replace(/[\p{Cc}<>:"/\\|?*]/gu, '_')
    .replace(/[. ]+$/u, '')
  if (utf8Length(cleaned) > MANAGED_ORIGINAL_FILE_NAME_MAX_UTF8_BYTES) {
    const dot = cleaned.lastIndexOf('.')
    const extension = dot > 0 && cleaned.length - dot <= 16 ? cleaned.slice(dot) : ''
    const stem = Array.from(extension ? cleaned.slice(0, dot) : cleaned)
    while (
      stem.length &&
      utf8Length(stem.join('') + extension) > MANAGED_ORIGINAL_FILE_NAME_MAX_UTF8_BYTES
    )
      stem.pop()
    cleaned = `${stem.join('')}${extension}`.replace(/[. ]+$/u, '')
  }
  if (!cleaned.trim() || cleaned === '.' || cleaned === '..') return fallback
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

/** Longest edge of the copy an earlier turn's image is replaced with in a model request. */
export const HISTORY_IMAGE_REQUEST_MAX_EDGE = 1024
/** An earlier image at or below this size (or this edge) is sent as it is. */
export const HISTORY_IMAGE_SMALL_BYTES = 512 * 1024

const knownSizeBytes = (attachment: ChatAttachment, managedSize?: number): number | undefined => {
  const size = managedSize ?? attachment.sizeBytes
  if (typeof size === 'number' && Number.isFinite(size) && size >= 0) return size
  const match = /^data:[^,]*;base64,/iu.exec(attachment.url || '')
  if (!match) return undefined
  return Math.floor(((attachment.url.length - match[0].length) * 3) / 4)
}

const isSmallHistoryImage = (
  attachment: ChatAttachment,
  managed: ReturnType<typeof normalizeMediaReference>
): boolean => {
  const width = managed?.width ?? attachment.sourceWidth
  const height = managed?.height ?? attachment.sourceHeight
  if (
    typeof width === 'number' &&
    typeof height === 'number' &&
    width > 0 &&
    height > 0 &&
    Math.max(width, height) <= HISTORY_IMAGE_REQUEST_MAX_EDGE
  ) {
    return true
  }
  const size = knownSizeBytes(attachment, managed?.sizeBytes)
  return size !== undefined && size <= HISTORY_IMAGE_SMALL_BYTES
}

const historyImageOmittedNote = (name: string): string =>
  // i18next returns nothing before it is initialised.
  i18next.t('chat.history_image_omitted', { name }) ||
  `[An earlier image (${name}) could not be downscaled and was not sent this time]`

const historyImageOrdinalName = (index: number): string =>
  i18next.t('chat.history_image_ordinal', { index }) || `image ${index}`

/**
 * Replace the images of earlier turns with smaller copies before a request that sends the
 * whole image history ('all' policy), so old full-size images cannot overflow the request.
 *
 * The latest turn is the last user message: every image on it (including a resend or an
 * edited resend) is sent unchanged. Every other image is earlier history:
 * - small enough already (both edges <= HISTORY_IMAGE_REQUEST_MAX_EDGE, or at most
 *   HISTORY_IMAGE_SMALL_BYTES): sent unchanged;
 * - a managed image: replaced by the store's own bounded derivative (ensureDerivative, longest
 *   edge HISTORY_IMAGE_REQUEST_MAX_EDGE), read later through its local-media URL like any
 *   other request image;
 * - otherwise (no derivative service, a derivative error or an animated GIF, the route cannot
 *   carry a request data URL, a large non-managed image): left out of this request, with a
 *   short note naming the image appended to that message's text. A remote URL of unknown size
 *   and report-bundle images are never touched.
 * The input messages are not modified. An abort is rethrown.
 */
export const downscaleHistoryImagesForRequest = async <T extends ChatMessage>(
  messages: readonly T[],
  options: {
    ensureDerivative?: ManagedMediaSvc['ensureDerivative']
    /** Whether the route can send a non-managed local image (request-data-url). */
    canSendDerivative: boolean
    signal?: AbortSignal
  }
): Promise<T[]> => {
  const latestUserIndex = messages.findLastIndex((message) => message.role === 'user')
  const derivatives = new Map<string, ReturnType<ManagedMediaSvc['ensureDerivative']>>()
  const deriveOnce = (
    reference: NonNullable<ReturnType<typeof normalizeMediaReference>>
  ): ReturnType<ManagedMediaSvc['ensureDerivative']> => {
    const key = reference.sha256 || reference.relativePath
    let pending = derivatives.get(key)
    if (!pending) {
      pending = options.ensureDerivative!({
        reference,
        maxEdge: HISTORY_IMAGE_REQUEST_MAX_EDGE
      })
      derivatives.set(key, pending)
    }
    return pending
  }

  const result: T[] = []
  for (const [index, message] of messages.entries()) {
    if (index === latestUserIndex || !message.attachments?.some((a) => a.type === 'image')) {
      result.push(message)
      continue
    }
    const attachments: ChatAttachment[] = []
    const omitted: string[] = []
    let imageOrdinal = 0
    let changed = false
    for (const attachment of message.attachments) {
      if (attachment.type !== 'image') {
        attachments.push(attachment)
        continue
      }
      imageOrdinal += 1
      const reference = normalizeMediaReference(attachment.media)
      const managed = reference?.kind === 'managed' ? reference : undefined
      if (
        attachment.reportBundleId ||
        attachment.reportBundleRole ||
        isSmallHistoryImage(attachment, managed) ||
        (!managed && knownSizeBytes(attachment) === undefined)
      ) {
        attachments.push(attachment)
        continue
      }
      changed = true
      const name =
        attachment.fileName || managed?.originalFileName || historyImageOrdinalName(imageOrdinal)
      if (managed && options.canSendDerivative && options.ensureDerivative) {
        try {
          const derivative = await deriveOnce(managed)
          if (derivative.status === 'ready') {
            const { descriptor } = derivative
            const replacement: ChatAttachment = {
              ...attachment,
              url: descriptor.localMediaUrl,
              mimeType: descriptor.mimeType,
              sizeBytes: descriptor.sizeBytes,
              sourceWidth: descriptor.width,
              sourceHeight: descriptor.height
            }
            delete replacement.media
            attachments.push(replacement)
            continue
          }
        } catch (error) {
          if (options.signal?.aborted) throw error
          console.warn('[chatManagedMediaAttachments] History image derivative unavailable:', error)
        }
      }
      if (options.signal?.aborted) throw options.signal.reason ?? new Error('Aborted')
      console.warn('[chatManagedMediaAttachments] Earlier image left out of the request:', name)
      omitted.push(name)
    }
    if (!changed) {
      result.push(message)
      continue
    }
    const notes = omitted.map(historyImageOmittedNote).join('\n')
    result.push({
      ...message,
      attachments: attachments.length > 0 ? attachments : undefined,
      content: notes
        ? message.content
          ? `${message.content}\n\n${notes}`
          : notes
        : message.content
    })
  }
  return result
}
