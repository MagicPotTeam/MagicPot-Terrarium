import {
  useCallback,
  useEffect,
  useRef,
  type DragEvent as ReactDragEvent,
  type MutableRefObject,
  type RefObject
} from 'react'
import { hasActiveQuickAppImagePasteTarget } from '@renderer/utils/quickAppPasteTarget'
import { api } from '@renderer/utils/windowUtils'
import {
  getDroppedAttachmentFile,
  parseInternalImageDragPayload
} from '@renderer/utils/droppedImageUtils'
import { guessMimeTypeFromFileName } from '@renderer/utils/fileDisplay'
import { stripHtmlToText } from '@renderer/utils/htmlText'
import type { ChatAttachment, OCRResult } from '@shared/api/svcLLMProxy'
import type { FileItem } from '@shared/comfy/types'
import {
  getDownloadFileNameFromUrl,
  normalizeLocalMediaUrl,
  resolveLocalMediaPathFromUrl
} from '../ChatPage/chatPageShared'
import { getProjectCanvasLocation, isCanvasFile } from './canvasStorage'
import { collectDroppedDirectoryFiles } from './dropDirectory'
import { isPsdImportFile } from './psdImportDetection'
import { resolveDroppedAgentImageDataUrl } from './projectCanvasPageShared'
import { detectFileType, isModelArchiveFile } from './types'
import { CANVAS_IMPORT_ACCEPT } from './canvasImportAccept'
import type { CanvasFileItem, CanvasImageItem } from './types'
import { getElectronCanvasFilePath, resolveCanvasImageFileSource } from './canvasLocalFileSource'
import { buildCanvasImageSourceIdentity } from './canvasThumbnailCache'
import type { CanvasImageSourceIdentity } from './canvasThumbnailTypes'
import {
  readCanvasImageBlobMetadata,
  type CanvasImageSourceInput
} from './canvasAssetIntakeHelpers'
import type { CanvasImageBatchImportProgress } from './useCanvasAssetIntake'
import { readProjectCanvasBenchmarkSharedThumbnailCacheRoot } from './projectCanvasBenchmarkRuntime'

type CanvasImageSourceObject = Exclude<CanvasImageSourceInput, string>

type AddImageToCanvasFn = (
  src: string,
  options?: {
    clientX?: number
    clientY?: number
    fileName?: string
    sizeBytes?: number
    promptId?: string
    fileItem?: FileItem
    hasAlpha?: boolean
    sourceWidthHint?: number
    sourceHeightHint?: number
    sourceFile?: Blob
    sourceIdentity?: CanvasImageSourceIdentity
    thumbnailSet?: CanvasImageItem['thumbnailSet']
    reportBundleId?: CanvasImageItem['reportBundleId']
    reportBundleRole?: CanvasImageItem['reportBundleRole']
    reportBundleRefName?: CanvasImageItem['reportBundleRefName']
    reportBundleManifestUrl?: CanvasImageItem['reportBundleManifestUrl']
  }
) => Promise<unknown>

type AddImagesToCanvasFn = (sources: CanvasImageSourceInput[]) => Promise<unknown>

type AddModel3DToCanvasFn = (
  file: File,
  options?: {
    linkedAssets?: Record<string, string>
    skipTexturePrompt?: boolean
  }
) => Promise<unknown>

type AddModel3DUrlToCanvasFn = (
  src: string,
  options?: {
    clientX?: number
    clientY?: number
    select?: boolean
  }
) => unknown

type AddFileToCanvasFn = (
  file: File,
  clientX?: number,
  clientY?: number,
  options?: {
    reportBundleId?: CanvasFileItem['reportBundleId']
    reportBundleRole?: CanvasFileItem['reportBundleRole']
    reportBundleRefName?: CanvasFileItem['reportBundleRefName']
    reportBundleManifestUrl?: CanvasFileItem['reportBundleManifestUrl']
  }
) => Promise<unknown>
type AddVideoToCanvasFn = (
  file: File,
  options?: {
    clientX?: number
    clientY?: number
    promptId?: string
    fileItem?: FileItem
  }
) => Promise<unknown> | unknown
type AddTextToCanvasFn = (text: string, clientX?: number, clientY?: number) => void

type AddOcrResultToCanvasFn = (options: {
  file: File
  attachment?: ChatAttachment
  ocrResult: OCRResult
  clientX?: number
  clientY?: number
}) => Promise<unknown>

type AgentVideoDragPayload = {
  url: string
  fileName?: string
}

type ImportCanvasSceneFileFn = (file: File) => Promise<unknown>
type ImportPsdFileFn = (file: File) => Promise<unknown>

type DropDataTransferSnapshot = Pick<DataTransfer, 'files' | 'items' | 'getData'>

const DROP_TEXT_TYPES_TO_SNAPSHOT = [
  'application/x-qapp-image',
  'application/x-ai-image',
  'application/x-ai-video',
  'application/x-ai-model3d',
  'text/plain',
  'text',
  'Text',
  'text/html',
  'text/uri-list'
] as const

const CANVAS_IMAGE_FILE_SOURCE_RESOLVE_BATCH_SIZE = 16

function clearFileArrayReferences(files: File[]): void {
  for (let index = 0; index < files.length; index += 1) {
    files[index] = undefined as unknown as File
  }
  files.length = 0
}

function arrayFromTransferList<T>(list: ArrayLike<T> | Iterable<T> | null | undefined): T[] {
  if (!list) {
    return []
  }

  try {
    return Array.from(list)
  } catch {
    const length = Number((list as ArrayLike<T>).length)
    if (!Number.isFinite(length) || length <= 0) {
      return []
    }

    const values: T[] = []
    for (let index = 0; index < length; index += 1) {
      const value = (list as ArrayLike<T>)[index]
      if (value !== undefined) {
        values.push(value)
      }
    }
    return values
  }
}

function getDataTransferTypes(dataTransfer: DataTransfer): string[] {
  const rawTypes = dataTransfer.types
  const types = arrayFromTransferList<string>(rawTypes)
  if (types.length > 0) {
    return types
  }

  if (!rawTypes) {
    return []
  }

  const legacyTypes = rawTypes as unknown as {
    contains?: (type: string) => boolean
    item?: (index: number) => string | null
    length?: number
  }
  if (typeof legacyTypes.item === 'function') {
    const length = Number(legacyTypes.length)
    if (Number.isFinite(length) && length > 0) {
      const collected: string[] = []
      for (let index = 0; index < length; index += 1) {
        const value = legacyTypes.item(index)
        if (value) {
          collected.push(value)
        }
      }
      if (collected.length > 0) {
        return collected
      }
    }
  }

  if (typeof legacyTypes.contains === 'function') {
    return ['Files', 'text/uri-list', 'application/x-moz-file'].filter((type) =>
      legacyTypes.contains?.(type)
    )
  }

  return []
}

function isExternalFileDragType(type: string): boolean {
  const normalizedType = type.trim().toLowerCase()
  return (
    normalizedType === 'files' ||
    normalizedType === 'text/uri-list' ||
    normalizedType === 'application/x-moz-file' ||
    normalizedType.startsWith('application/x-qt-windows-mime') ||
    normalizedType.includes('filename')
  )
}

type SnapshotDataTransferItem = DataTransferItem & {
  webkitGetAsEntry?: () => FileSystemEntry | null
}

function snapshotDataTransferItem(item: DataTransferItem): DataTransferItem {
  let file: File | null = null
  let entry: FileSystemEntry | null = null

  if (item.kind === 'file') {
    try {
      file = item.getAsFile()
    } catch {
      file = null
    }

    try {
      entry = (item as SnapshotDataTransferItem).webkitGetAsEntry?.() ?? null
    } catch {
      entry = null
    }
  }

  const snapshot: SnapshotDataTransferItem = {
    kind: item.kind,
    type: item.type,
    getAsFile: () => file,
    getAsString: (callback: ((data: string) => void) | null) => {
      if (!callback) {
        return
      }

      try {
        item.getAsString(callback)
      } catch {
        callback('')
      }
    }
  } as SnapshotDataTransferItem

  if (entry) {
    snapshot.webkitGetAsEntry = () => entry
  }

  return snapshot as DataTransferItem
}

function getSnapshotDataTransferItemFiles(items: DataTransferItem[]): File[] {
  const files: File[] = []
  for (const item of items) {
    if (item.kind !== 'file') {
      continue
    }

    try {
      const file = item.getAsFile()
      if (file) {
        files.push(file)
      }
    } catch {
      // Ignore inaccessible items and keep any other files that were snapshotted.
    }
  }
  return files
}

function snapshotDropDataTransfer(dataTransfer: DataTransfer): DropDataTransferSnapshot {
  const directFiles = arrayFromTransferList<File>(dataTransfer.files)
  const items = arrayFromTransferList<DataTransferItem>(dataTransfer.items).map(
    snapshotDataTransferItem
  )
  const itemFiles = getSnapshotDataTransferItemFiles(items)
  const files = directFiles.length > 0 ? directFiles : itemFiles
  const textData = new Map<string, string>()

  for (const type of DROP_TEXT_TYPES_TO_SNAPSHOT) {
    try {
      textData.set(type, dataTransfer.getData(type) || '')
    } catch {
      textData.set(type, '')
    }
  }

  return {
    files,
    items,
    getData: (type: string) => textData.get(type) || ''
  } as unknown as DropDataTransferSnapshot
}

function isExternalFileDrag(dataTransfer?: DataTransfer | null): boolean {
  if (!dataTransfer) {
    return false
  }

  if (dataTransfer.files && dataTransfer.files.length > 0) {
    return true
  }

  if (
    dataTransfer.items &&
    arrayFromTransferList<DataTransferItem>(dataTransfer.items).some((item) => item.kind === 'file')
  ) {
    return true
  }

  return getDataTransferTypes(dataTransfer).some(isExternalFileDragType)
}

const CANVAS_DOCUMENT_DROP_BYPASS_SELECTOR = [
  '[data-agent-workspace-root]',
  '[data-agent-workspace-scope]',
  '[data-chat-page-root]',
  '[data-canvas-document-drop-bypass]',
  'input',
  'textarea',
  '[contenteditable="true"]'
].join(',')

function getDragEventTargetElement(event: DragEvent): Element | null {
  const path = typeof event.composedPath === 'function' ? event.composedPath() : []
  for (const target of path) {
    if (target instanceof Element) {
      return target
    }
  }

  if (event.target instanceof Element) {
    return event.target
  }

  if (event.target instanceof Node) {
    return event.target.parentElement
  }

  return null
}

function getDragEventPointElements(event: DragEvent): Element[] {
  if (
    !Number.isFinite(event.clientX) ||
    !Number.isFinite(event.clientY) ||
    typeof document.elementsFromPoint !== 'function'
  ) {
    return []
  }

  return document
    .elementsFromPoint(event.clientX, event.clientY)
    .filter((node): node is Element => {
      return node instanceof Element
    })
}

function shouldBypassCanvasDocumentDrop(event: DragEvent): boolean {
  if (getDragEventTargetElement(event)?.closest(CANVAS_DOCUMENT_DROP_BYPASS_SELECTOR)) {
    return true
  }

  return getDragEventPointElements(event).some((element) =>
    Boolean(element.closest(CANVAS_DOCUMENT_DROP_BYPASS_SELECTOR))
  )
}

type UseCanvasFileIntakeOptions = {
  canvasId: string
  canvasContainerRef: RefObject<HTMLElement | null>
  canvasActiveRef: MutableRefObject<boolean>
  notifyWarning?: (message: string) => unknown
  addImageToCanvas: AddImageToCanvasFn
  addImagesToCanvas: AddImagesToCanvasFn
  addModel3DToCanvas: AddModel3DToCanvasFn
  addModel3DUrlToCanvas: AddModel3DUrlToCanvasFn
  addVideoToCanvas: AddVideoToCanvasFn
  addFileToCanvas: AddFileToCanvasFn
  addOcrResultToCanvas: AddOcrResultToCanvasFn
  addTextToCanvas: AddTextToCanvasFn
  handleImportCanvasSceneFile: ImportCanvasSceneFileFn
  handleImportPsdFile: ImportPsdFileFn
  focusCanvasStage: () => void
  onImageBatchImportProgress?: (progress: CanvasImageBatchImportProgress | null) => void
}

const CLIPBOARD_FILE_EXTENSION_BY_MIME: Record<string, string> = {
  'application/msword': '.doc',
  'application/vnd.ms-excel': '.xls',
  'application/vnd.ms-powerpoint': '.ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'model/gltf+json': '.gltf',
  'model/gltf-binary': '.glb',
  'text/csv': '.csv',
  'text/markdown': '.md',
  'text/plain': '.txt'
}

async function resolveCanvasThumbnailCacheRoot(canvasId?: string): Promise<string | undefined> {
  const benchmarkSharedRoot = readProjectCanvasBenchmarkSharedThumbnailCacheRoot()
  if (benchmarkSharedRoot) {
    return benchmarkSharedRoot
  }

  if (!canvasId || !window.path || typeof window.path.join !== 'function') {
    return undefined
  }

  const location = await getProjectCanvasLocation(canvasId)
  return location
    ? window.path.join(location.projectRootDir, '.cache', 'canvas-thumbnails')
    : undefined
}

async function resolveCanvasImageLocalSourceIdentity(
  file: File,
  cacheRootDir?: string
): Promise<CanvasImageSourceIdentity | undefined> {
  const thumbnailService = window.api?.svcCanvasThumbnail
  if (!thumbnailService?.getSourceFileMetadata) {
    return undefined
  }

  const fullPath = getElectronCanvasFilePath(file)
  if (!fullPath) {
    return undefined
  }

  try {
    const metadata = await thumbnailService.getSourceFileMetadata({ fullPath })
    if (!metadata.exists) {
      return undefined
    }

    return (
      buildCanvasImageSourceIdentity({
        canonicalPath: metadata.canonicalPath,
        sizeBytes: metadata.sizeBytes,
        lastModifiedMs: metadata.lastModifiedMs,
        cacheRootDir
      }) ?? undefined
    )
  } catch (error) {
    console.warn('[Canvas] Failed to resolve image source identity:', fullPath, error)
    return undefined
  }
}

function isEditableElement(target: Element | null): target is HTMLElement {
  return Boolean(
    target &&
    (target.tagName === 'INPUT' ||
      target.tagName === 'TEXTAREA' ||
      (target as HTMLElement).isContentEditable)
  )
}

function isCanvasPasteProxyElement(
  target: Element | null,
  pasteProxy: HTMLTextAreaElement | null
): target is HTMLTextAreaElement {
  return Boolean(target && pasteProxy && target === pasteProxy)
}

function isPasteShortcut(event: KeyboardEvent): boolean {
  if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) {
    return false
  }

  return event.key.toLowerCase() === 'v' || event.code === 'KeyV'
}

function isUnsupportedPureRefFile(file: Pick<File, 'name'>): boolean {
  return file.name.trim().toLowerCase().endsWith('.pur')
}

function isSupportedClipboardFile(file: File, clipboardType?: string): boolean {
  const normalizedFile = normalizeClipboardFile(file, clipboardType)
  const fileType = detectFileType(normalizedFile.name)
  const normalizedClipboardType = (clipboardType || normalizedFile.type || '').trim().toLowerCase()
  return (
    isCanvasFile(normalizedFile.name) ||
    isPsdImportFile(normalizedFile) ||
    normalizedClipboardType.startsWith('image/') ||
    fileType === 'image' ||
    fileType === 'model3d' ||
    fileType === 'video' ||
    fileType === 'file' ||
    isModelArchiveFile(normalizedFile.name) ||
    normalizedClipboardType.startsWith('video/')
  )
}

function getClipboardFileExtension(mimeType?: string): string {
  const normalizedMimeType = mimeType?.trim().toLowerCase() || ''
  if (!normalizedMimeType) {
    return ''
  }

  if (CLIPBOARD_FILE_EXTENSION_BY_MIME[normalizedMimeType]) {
    return CLIPBOARD_FILE_EXTENSION_BY_MIME[normalizedMimeType]
  }

  if (normalizedMimeType.startsWith('image/')) {
    const subtype = normalizedMimeType.split('/')[1]?.split('+')[0]?.trim()
    return subtype ? `.${subtype === 'jpeg' ? 'jpg' : subtype}` : ''
  }

  if (normalizedMimeType.startsWith('video/')) {
    const subtype = normalizedMimeType.split('/')[1]?.split('+')[0]?.trim()
    return subtype ? `.${subtype}` : ''
  }

  return ''
}

function normalizeClipboardFile(file: File, clipboardType?: string, index = 1): File {
  const normalizedMimeType = (clipboardType || file.type || '').trim().toLowerCase()
  const extension = getClipboardFileExtension(normalizedMimeType)
  const trimmedName = file.name.trim()
  const hasSupportedName =
    Boolean(trimmedName) &&
    (Boolean(detectFileType(trimmedName)) ||
      isCanvasFile(trimmedName) ||
      isPsdImportFile(file) ||
      isModelArchiveFile(trimmedName))

  if (hasSupportedName || !extension) {
    return file
  }

  const nextName = trimmedName ? `${trimmedName}${extension}` : `pasted-${index}${extension}`
  return new File([file], nextName, {
    type: file.type || normalizedMimeType || undefined,
    lastModified: file.lastModified
  })
}

function parseAgentVideoDragPayload(raw: string): AgentVideoDragPayload | null {
  const trimmed = raw.trim()
  if (!trimmed) return null

  try {
    const parsed = JSON.parse(trimmed) as Partial<AgentVideoDragPayload>
    if (typeof parsed.url === 'string' && parsed.url.trim()) {
      return {
        url: parsed.url.trim(),
        fileName:
          typeof parsed.fileName === 'string' && parsed.fileName.trim()
            ? parsed.fileName
            : undefined
      }
    }
  } catch {
    // Legacy payloads may be a plain URL.
  }

  return { url: trimmed }
}

async function readUrlAsFile(url: string, fallbackFileName: string): Promise<File> {
  const response = await fetch(url)
  if (!response.ok && response.status !== 0) {
    throw new Error(`Failed to load dropped URL (${response.status})`)
  }

  const blob = await response.blob()
  const fileName = fallbackFileName.trim() || 'download'
  return new File([blob], fileName, {
    type: blob.type || guessMimeTypeFromFileName(fileName)
  })
}

function normalizeLocalUrlFileName(url: string, fallbackFileName: string): string {
  return getDownloadFileNameFromUrl(normalizeLocalMediaUrl(url), fallbackFileName)
}

function normalizeLocalUrlFile(url: string, fallbackFileName: string, mimeFallback?: string): File {
  const normalizedUrl = normalizeLocalMediaUrl(url)
  const fileName = normalizeLocalUrlFileName(normalizedUrl, fallbackFileName)
  const localPath = resolveLocalMediaPathFromUrl(normalizedUrl) || normalizedUrl
  const file = new File([], fileName, {
    type: guessMimeTypeFromFileName(fileName, mimeFallback || 'application/octet-stream')
  })
  Object.defineProperty(file, 'path', {
    configurable: true,
    value: localPath
  })
  return file
}

function isLocalMediaLikeUrl(url: string): boolean {
  const normalized = url.trim().toLowerCase()
  return normalized.startsWith('local-media://') || normalized.startsWith('file://')
}

async function resolveAgentVideoDropFile(
  dropDataTransfer: DropDataTransferSnapshot,
  internalImagePayload: ReturnType<typeof parseInternalImageDragPayload>
): Promise<File | null> {
  const droppedVideoFile = Array.from(dropDataTransfer.files).find((file) => {
    const type = (file.type || '').toLowerCase()
    return type.startsWith('video/') || detectFileType(file.name) === 'video'
  })
  if (droppedVideoFile) {
    return droppedVideoFile
  }

  const internalVideoAttachment = internalImagePayload?.attachments?.find(
    (attachment) => attachment.type === 'video'
  )
  const agentVideoPayload = parseAgentVideoDragPayload(
    dropDataTransfer.getData('application/x-ai-video')
  )
  const videoUrl = (
    internalVideoAttachment?.url ||
    agentVideoPayload?.url ||
    (internalImagePayload?.itemTypes?.includes('video') ? internalImagePayload.objectUrl : '') ||
    ''
  ).trim()
  const fileName =
    internalVideoAttachment?.fileName ||
    agentVideoPayload?.fileName ||
    internalImagePayload?.fileItem?.filename ||
    normalizeLocalUrlFileName(videoUrl, 'dropped-video.mp4')

  if (internalImagePayload?.fileItem?.filename) {
    try {
      const response = await api().svcComfy.getView(internalImagePayload.fileItem)
      return new File([response.result as BlobPart], internalImagePayload.fileItem.filename, {
        type: guessMimeTypeFromFileName(internalImagePayload.fileItem.filename, 'video/mp4')
      })
    } catch (error) {
      if (!videoUrl) {
        throw error
      }
    }
  }

  if (!videoUrl) {
    return null
  }

  if (isLocalMediaLikeUrl(videoUrl)) {
    return normalizeLocalUrlFile(videoUrl, fileName, 'video/mp4')
  }

  return readUrlAsFile(videoUrl, fileName)
}

function normalizeClipboardHtmlText(html: string): string {
  const trimmed = html.trim()
  if (!trimmed) return ''

  if (typeof DOMParser !== 'undefined') {
    const doc = new DOMParser().parseFromString(trimmed, 'text/html')
    const tableRows = Array.from(doc.body?.querySelectorAll('tr') || [])
      .map((row) =>
        Array.from(row.querySelectorAll('th,td'))
          .map((cell) => cell.textContent?.trim() || '')
          .join('\t')
      )
      .filter((row) => row.trim())
    if (tableRows.length > 0) {
      return tableRows.join('\n')
    }

    const text = doc.body?.textContent?.trim()
    if (text) {
      return text
    }
  }

  return trimmed
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function getDirectClipboardPlainText(clipboardData?: Pick<DataTransfer, 'getData'> | null): string {
  if (!clipboardData) return ''

  return (
    clipboardData.getData('text/plain') ||
    clipboardData.getData('text') ||
    clipboardData.getData('Text') ||
    ''
  )
}

function getClipboardPlainText(clipboardData?: DataTransfer | null): string {
  if (!clipboardData) return ''

  const plainText = getDirectClipboardPlainText(clipboardData)
  if (plainText.trim()) {
    return plainText.trim()
  }

  return normalizeClipboardHtmlText(clipboardData.getData('text/html'))
}

export function useCanvasFileIntake({
  canvasId,
  canvasContainerRef,
  canvasActiveRef,
  notifyWarning,
  addImageToCanvas,
  addImagesToCanvas,
  addModel3DToCanvas,
  addModel3DUrlToCanvas,
  addVideoToCanvas,
  addFileToCanvas,
  addOcrResultToCanvas,
  addTextToCanvas,
  handleImportCanvasSceneFile,
  handleImportPsdFile,
  focusCanvasStage,
  onImageBatchImportProgress
}: UseCanvasFileIntakeOptions) {
  const pasteProxyRef = useRef<HTMLTextAreaElement | null>(null)
  const handledPasteCounterRef = useRef(0)
  const awaitingKeyboardPasteEventRef = useRef(false)
  const manualPasteFallbackInFlightRef = useRef(false)

  useEffect(() => {
    const canvasContainer = canvasContainerRef.current
    if (!canvasContainer || pasteProxyRef.current) {
      return
    }

    const pasteProxy = document.createElement('textarea')
    pasteProxy.setAttribute('data-canvas-paste-proxy', 'true')
    pasteProxy.setAttribute('aria-hidden', 'true')
    pasteProxy.tabIndex = -1
    pasteProxy.value = ''
    Object.assign(pasteProxy.style, {
      position: 'absolute',
      top: '0',
      left: '0',
      width: '1px',
      height: '1px',
      opacity: '0',
      pointerEvents: 'none',
      zIndex: '-1',
      padding: '0',
      border: '0',
      margin: '0'
    })
    pasteProxy.addEventListener('focus', () => {
      canvasActiveRef.current = true
    })
    canvasContainer.appendChild(pasteProxy)
    pasteProxyRef.current = pasteProxy

    return () => {
      if (pasteProxyRef.current === pasteProxy) {
        pasteProxyRef.current = null
      }
      pasteProxy.remove()
    }
  }, [canvasActiveRef, canvasContainerRef])

  const readFileAsDataURL = useCallback((file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as string)
      reader.onerror = () => reject(new Error('Failed to read file.'))
      reader.readAsDataURL(file)
    })
  }, [])

  const resolveImageFileSource = useCallback(
    async (file: File) => resolveCanvasImageFileSource(file, readFileAsDataURL),
    [readFileAsDataURL]
  )

  const resolveImageFileSourceInput = useCallback(
    async (file: File): Promise<CanvasImageSourceObject> => {
      const [src, metadata] = await Promise.all([
        resolveImageFileSource(file),
        readCanvasImageBlobMetadata(file)
      ])
      const thumbnailCacheRoot = await resolveCanvasThumbnailCacheRoot(canvasId)
      const sourceIdentity = await resolveCanvasImageLocalSourceIdentity(file, thumbnailCacheRoot)
      const shouldRetainSourceFile = !/^(local-media|file):\/\//i.test(src.trim())
      const source: CanvasImageSourceObject = {
        src,
        fileName: file.name,
        sizeBytes: file.size,
        // Durable local-media/file URLs can be reopened through the preload filesystem bridge.
        // Do not keep every File object in React canvas state for large Electron imports.
        ...(shouldRetainSourceFile ? { sourceFile: file } : {}),
        ...(sourceIdentity ? { sourceIdentity } : {})
      }

      if (metadata) {
        source.sourceWidthHint = metadata.width
        source.sourceHeightHint = metadata.height
        if (typeof metadata.hasAlpha === 'boolean') {
          source.hasAlpha = metadata.hasAlpha
        }
      }

      return source
    },
    [canvasId, resolveImageFileSource]
  )

  const resolveImageFileSourceInputs = useCallback(
    async (
      files: File[],
      options: { reportProgress?: boolean } = {}
    ): Promise<CanvasImageSourceInput[]> => {
      const sources: CanvasImageSourceInput[] = []
      const shouldReportProgress =
        options.reportProgress && files.length >= CANVAS_IMAGE_FILE_SOURCE_RESOLVE_BATCH_SIZE
      let processedCount = 0
      if (shouldReportProgress) {
        onImageBatchImportProgress?.({
          phase: 'preparing',
          total: files.length,
          processed: 0,
          imported: 0,
          failed: 0
        })
      }
      for (
        let index = 0;
        index < files.length;
        index += CANVAS_IMAGE_FILE_SOURCE_RESOLVE_BATCH_SIZE
      ) {
        const batch = files.slice(index, index + CANVAS_IMAGE_FILE_SOURCE_RESOLVE_BATCH_SIZE)
        const batchLength = batch.length
        sources.push(...(await Promise.all(batch.map(resolveImageFileSourceInput))))
        for (let batchIndex = 0; batchIndex < batchLength; batchIndex += 1) {
          files[index + batchIndex] = undefined as unknown as File
        }
        batch.length = 0
        processedCount += batchLength
        if (shouldReportProgress) {
          onImageBatchImportProgress?.({
            phase: 'preparing',
            total: files.length,
            processed: processedCount,
            imported: 0,
            failed: 0
          })
        }
      }
      return sources
    },
    [onImageBatchImportProgress, resolveImageFileSourceInput]
  )

  const readClipboardTextItem = useCallback((item: DataTransferItem): Promise<string> => {
    return new Promise((resolve) => {
      item.getAsString((text) => resolve(text))
    })
  }, [])

  const canvasOwnsClipboardFocus = useCallback(() => {
    const canvasContainer = canvasContainerRef.current
    const active = document.activeElement

    if (!canvasContainer) {
      return canvasActiveRef.current
    }

    return Boolean(
      canvasActiveRef.current ||
      (active instanceof Node && (active === canvasContainer || canvasContainer.contains(active)))
    )
  }, [canvasActiveRef, canvasContainerRef])

  const shouldRoutePasteToCanvas = useCallback(() => {
    const active = document.activeElement
    const isPasteProxyFocused = isCanvasPasteProxyElement(active, pasteProxyRef.current)

    if (isEditableElement(active) && !isPasteProxyFocused) {
      return false
    }

    if (hasActiveQuickAppImagePasteTarget()) {
      return false
    }

    return true
  }, [])

  const handleFile = useCallback(
    async (file: File, clientX?: number, clientY?: number) => {
      if (isCanvasFile(file.name)) {
        try {
          await handleImportCanvasSceneFile(file)
        } catch (error) {
          console.error('[Canvas] Canvas file import failed:', error)
        }
        return
      }

      if (isPsdImportFile(file)) {
        await handleImportPsdFile(file)
        return
      }

      if (isUnsupportedPureRefFile(file)) {
        notifyWarning?.('PureRef .pur files are not supported by MagicPot Project Canvas.')
        return
      }

      const fileType = detectFileType(file.name)

      if (fileType === 'image' || file.type.startsWith('image/')) {
        const source = await resolveImageFileSourceInput(file)
        await addImageToCanvas(source.src, {
          clientX,
          clientY,
          fileName: file.name,
          sizeBytes: file.size,
          hasAlpha: source.hasAlpha,
          sourceWidthHint: source.sourceWidthHint,
          sourceHeightHint: source.sourceHeightHint,
          sourceFile: source.sourceFile,
          sourceIdentity: source.sourceIdentity,
          thumbnailSet: source.thumbnailSet
        })
        return
      }

      if (fileType === 'model3d' || isModelArchiveFile(file.name)) {
        await addModel3DToCanvas(file)
        return
      }

      if (fileType === 'video' || file.type.startsWith('video/')) {
        await addVideoToCanvas(file)
        return
      }

      if (fileType === 'file') {
        await addFileToCanvas(file, clientX, clientY)
      }
    },
    [
      addFileToCanvas,
      addImageToCanvas,
      handleImportCanvasSceneFile,
      addModel3DToCanvas,
      addVideoToCanvas,
      handleImportPsdFile,
      notifyWarning,
      resolveImageFileSourceInput
    ]
  )

  const handleCanvasSceneImport = useCallback(
    async (file: File) => {
      try {
        await handleImportCanvasSceneFile(file)
      } catch (error) {
        console.error('[Canvas] Canvas file import failed:', error)
      }
    },
    [handleImportCanvasSceneFile]
  )

  const handleFiles = useCallback(
    async (files: File[], clientX?: number, clientY?: number) => {
      if (files.length === 0) return

      const imageFiles: File[] = []
      const otherFiles: File[] = []

      for (const file of files) {
        if (isCanvasFile(file.name)) {
          otherFiles.push(file)
          continue
        }

        const fileType = detectFileType(file.name)
        if (fileType === 'image' || file.type.startsWith('image/')) {
          imageFiles.push(file)
        } else {
          otherFiles.push(file)
        }
      }
      clearFileArrayReferences(files)

      if (imageFiles.length > 0) {
        if (imageFiles.length === 1 && otherFiles.length === 0) {
          const imageFile = imageFiles[0]
          const fileName = imageFile.name
          const sizeBytes = imageFile.size
          const source = await resolveImageFileSourceInput(imageFile)
          clearFileArrayReferences(imageFiles)
          await addImageToCanvas(source.src, {
            clientX,
            clientY,
            fileName,
            sizeBytes,
            hasAlpha: source.hasAlpha,
            sourceWidthHint: source.sourceWidthHint,
            sourceHeightHint: source.sourceHeightHint,
            sourceFile: source.sourceFile,
            sourceIdentity: source.sourceIdentity,
            thumbnailSet: source.thumbnailSet
          })
        } else {
          const imageSources = await resolveImageFileSourceInputs(imageFiles, {
            reportProgress: true
          })
          clearFileArrayReferences(imageFiles)
          await addImagesToCanvas(imageSources)
        }
      }

      for (let index = 0; index < otherFiles.length; index += 1) {
        const file = otherFiles[index]
        otherFiles[index] = undefined as unknown as File
        if (isCanvasFile(file.name)) {
          await handleCanvasSceneImport(file)
          continue
        }

        await handleFile(file, clientX, clientY)
      }
      otherFiles.length = 0
    },
    [
      addImageToCanvas,
      addImagesToCanvas,
      handleCanvasSceneImport,
      handleFile,
      resolveImageFileSourceInput,
      resolveImageFileSourceInputs
    ]
  )

  const handleImportFiles = useCallback(
    async (files: File[]) => {
      await handleFiles(files)
    },
    [handleFiles]
  )

  const handleToolbarImportClick = useCallback(() => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = `.mpcanvas,${CANVAS_IMPORT_ACCEPT}`
    input.multiple = true
    input.onchange = async (event) => {
      const target = event.target as HTMLInputElement
      const files = Array.from(target.files || [])
      target.value = ''
      await handleFiles(files)
    }
    input.click()
  }, [handleFiles])

  const handleDropDataTransfer = useCallback(
    async (dropDataTransfer: DropDataTransferSnapshot, clientX?: number, clientY?: number) => {
      const internalImagePayload = parseInternalImageDragPayload(dropDataTransfer)
      const internalImageAttachment = internalImagePayload?.attachments?.find(
        (attachment) => attachment.type === 'image'
      )
      const internalFileAttachment = internalImagePayload?.attachments?.find(
        (attachment) => attachment.type === 'file'
      )
      if (internalImagePayload?.sourceCanvasId === canvasId) {
        return
      }

      const droppedOcrResult = internalFileAttachment?.ocrResult || internalImagePayload?.ocrResult
      const droppedAgentImage = await resolveDroppedAgentImageDataUrl(dropDataTransfer)
      if (droppedAgentImage) {
        await addImageToCanvas(droppedAgentImage.src, {
          clientX,
          clientY,
          fileName:
            droppedAgentImage.fileName ||
            internalImageAttachment?.fileName ||
            internalImagePayload?.fileItem?.filename,
          sizeBytes: droppedAgentImage.sizeBytes ?? internalImageAttachment?.sizeBytes,
          promptId: internalImagePayload?.promptId,
          fileItem: internalImagePayload?.fileItem,
          sourceWidthHint:
            droppedAgentImage.sourceWidthHint ??
            internalImageAttachment?.sourceWidth ??
            internalImagePayload?.sourceWidth,
          sourceHeightHint:
            droppedAgentImage.sourceHeightHint ??
            internalImageAttachment?.sourceHeight ??
            internalImagePayload?.sourceHeight,
          sourceFile: droppedAgentImage.sourceFile,
          reportBundleId: internalImageAttachment?.reportBundleId,
          reportBundleRole: internalImageAttachment?.reportBundleRole,
          reportBundleRefName: internalImageAttachment?.reportBundleRefName,
          reportBundleManifestUrl: internalImageAttachment?.reportBundleManifestUrl
        })
        return
      }

      const aiModel3D = dropDataTransfer.getData('application/x-ai-model3d')
      if (aiModel3D) {
        addModel3DUrlToCanvas(aiModel3D, {
          clientX,
          clientY,
          select: true
        })
        return
      }

      const droppedAgentVideoFile = await resolveAgentVideoDropFile(
        dropDataTransfer,
        internalImagePayload
      ).catch((error) => {
        console.warn('[Canvas] Failed to materialize dropped Agent video:', error)
        return null
      })
      if (droppedAgentVideoFile) {
        await addVideoToCanvas(droppedAgentVideoFile, {
          clientX,
          clientY,
          promptId: internalImagePayload?.promptId,
          fileItem: internalImagePayload?.fileItem
        })
        return
      }

      const droppedAgentFile = await getDroppedAttachmentFile(dropDataTransfer).catch((error) => {
        console.warn('[Canvas] Failed to materialize dropped Agent attachment:', error)
        return null
      })
      if (droppedAgentFile) {
        if (droppedOcrResult) {
          await addOcrResultToCanvas({
            file: droppedAgentFile,
            attachment: internalFileAttachment,
            ocrResult: droppedOcrResult,
            clientX,
            clientY
          })
          return
        }

        await addFileToCanvas(droppedAgentFile, clientX, clientY, {
          reportBundleId: internalFileAttachment?.reportBundleId,
          reportBundleRole: internalFileAttachment?.reportBundleRole,
          reportBundleRefName: internalFileAttachment?.reportBundleRefName,
          reportBundleManifestUrl: internalFileAttachment?.reportBundleManifestUrl
        })
        return
      }

      if (dropDataTransfer.getData('application/x-qapp-image')) {
        return
      }

      const droppedEntries = await collectDroppedDirectoryFiles(dropDataTransfer.items)
      const hasDirectoryStructure = droppedEntries.some((entry) => entry.path.includes('/'))

      if (hasDirectoryStructure) {
        const packageName = droppedEntries[0]?.path.split('/')[0] || 'package'
        const { extractModelPackageFiles } = await import('./modelArchive')
        const extractedPackage = extractModelPackageFiles(droppedEntries, packageName)
        if (extractedPackage) {
          await addModel3DToCanvas(extractedPackage.file, {
            linkedAssets: extractedPackage.linkedAssets,
            skipTexturePrompt: Object.keys(extractedPackage.linkedAssets).length > 0
          })
          return
        }
      }

      const droppedFiles = Array.from(dropDataTransfer.files)
      const files =
        hasDirectoryStructure || droppedFiles.length === 0
          ? droppedEntries.map((entry) => entry.file)
          : droppedFiles

      if (files.length === 0) {
        let text = dropDataTransfer.getData('text/plain')
        if (text && text.startsWith('MAGICPOT_DRAG::')) {
          return
        }

        if (!text) {
          text =
            dropDataTransfer.getData('text') ||
            dropDataTransfer.getData('Text') ||
            dropDataTransfer.getData('text/html')
          if (text) {
            text = stripHtmlToText(text)
          }
        }

        if (text && text.trim()) {
          focusCanvasStage()
          addTextToCanvas(text.trim(), clientX, clientY)
        }
        return
      }

      await handleFiles(files, clientX, clientY)
    },
    [
      addFileToCanvas,
      addImageToCanvas,
      addModel3DToCanvas,
      addModel3DUrlToCanvas,
      addOcrResultToCanvas,
      addVideoToCanvas,
      addTextToCanvas,
      canvasId,
      focusCanvasStage,
      handleFiles
    ]
  )

  const handleDrop = useCallback(
    async (event: ReactDragEvent) => {
      if (shouldBypassCanvasDocumentDrop(event.nativeEvent)) {
        return
      }

      event.preventDefault()
      event.stopPropagation()
      await handleDropDataTransfer(
        snapshotDropDataTransfer(event.dataTransfer),
        event.clientX,
        event.clientY
      )
    },
    [handleDropDataTransfer]
  )

  const handleDragOver = useCallback((event: ReactDragEvent) => {
    if (shouldBypassCanvasDocumentDrop(event.nativeEvent)) {
      return
    }

    event.preventDefault()
    event.stopPropagation()
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'copy'
    }
  }, [])

  const handleDocumentFileDragOver = useCallback((event: DragEvent) => {
    if (!isExternalFileDrag(event.dataTransfer)) {
      return
    }

    if (shouldBypassCanvasDocumentDrop(event)) {
      return
    }

    event.preventDefault()
    event.stopImmediatePropagation()
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'copy'
    }
  }, [])

  const handleDocumentFileDrop = useCallback(
    (event: DragEvent) => {
      if (!isExternalFileDrag(event.dataTransfer)) {
        return
      }

      if (shouldBypassCanvasDocumentDrop(event)) {
        return
      }

      event.preventDefault()
      event.stopImmediatePropagation()
      void handleDropDataTransfer(
        snapshotDropDataTransfer(event.dataTransfer!),
        event.clientX,
        event.clientY
      )
    },
    [handleDropDataTransfer]
  )

  useEffect(() => {
    document.addEventListener('dragenter', handleDocumentFileDragOver, true)
    document.addEventListener('dragover', handleDocumentFileDragOver, true)
    document.addEventListener('drop', handleDocumentFileDrop, true)
    return () => {
      document.removeEventListener('dragenter', handleDocumentFileDragOver, true)
      document.removeEventListener('dragover', handleDocumentFileDragOver, true)
      document.removeEventListener('drop', handleDocumentFileDrop, true)
    }
  }, [handleDocumentFileDragOver, handleDocumentFileDrop])

  const handleClipboardData = useCallback(
    async (clipboardData?: DataTransfer | null) => {
      const pastedFiles = clipboardData?.files
        ? Array.from(clipboardData.files).map((file, index) =>
            normalizeClipboardFile(file, file.type, index + 1)
          )
        : []
      const supportedPastedFiles = pastedFiles.filter((file) => isSupportedClipboardFile(file))

      if (supportedPastedFiles.length > 0) {
        for (const file of supportedPastedFiles) {
          await handleFile(file)
        }
        return true
      }

      const clipboardItems = clipboardData?.items
      const pastedItemFiles = clipboardItems
        ? Array.from(clipboardItems).flatMap((item, index) => {
            const file = item.getAsFile()
            if (!file) return []

            const normalizedFile = normalizeClipboardFile(file, item.type, index + 1)
            return isSupportedClipboardFile(normalizedFile, item.type) ? [normalizedFile] : []
          })
        : []

      if (pastedItemFiles.length > 0) {
        for (const file of pastedItemFiles) {
          await handleFile(file)
        }
        return true
      }

      const uriList = clipboardData?.getData('text/uri-list')?.trim()
      if (uriList) {
        const uris = uriList
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line && !line.startsWith('#'))

        if (uris.length > 0) {
          let handledUriCount = 0

          for (const uri of uris) {
            try {
              const response = await fetch(uri)
              if (!response.ok) continue

              const blob = await response.blob()
              const parsedUrl = new URL(uri)
              const fileName = decodeURIComponent(
                parsedUrl.pathname.split('/').pop() || `pasted-file-${handledUriCount + 1}`
              )
              const file = new File([blob], fileName, { type: blob.type })

              if (isSupportedClipboardFile(file)) {
                handledUriCount += 1
                await handleFile(file)
              }
            } catch {
              // Ignore invalid or inaccessible clipboard URIs.
            }
          }

          if (handledUriCount > 0) {
            return true
          }
        }
      }

      if (!clipboardItems || clipboardItems.length === 0) {
        const directClipboardText = getClipboardPlainText(clipboardData)
        if (directClipboardText) {
          addTextToCanvas(directClipboardText)
          return true
        }

        return false
      }

      const pastedImageSources: Array<{ src: string; fileName?: string; sizeBytes?: number }> = []
      for (const item of Array.from(clipboardItems)) {
        if (!item.type.startsWith('image/')) continue
        const blob = item.getAsFile()
        if (!blob) continue
        pastedImageSources.push({
          src: await readFileAsDataURL(blob),
          fileName: blob.name,
          sizeBytes: blob.size
        })
      }

      if (pastedImageSources.length > 0) {
        if (pastedImageSources.length === 1) {
          await addImageToCanvas(pastedImageSources[0].src, {
            fileName: pastedImageSources[0].fileName,
            sizeBytes: pastedImageSources[0].sizeBytes
          })
        } else {
          await addImagesToCanvas(pastedImageSources)
        }
        return true
      }

      for (const item of Array.from(clipboardItems)) {
        if (item.type !== 'text/plain') continue

        const text = await readClipboardTextItem(item)
        if (text.trim()) {
          addTextToCanvas(text.trim())
          return true
        }
      }

      const directClipboardText = getClipboardPlainText(clipboardData)
      if (directClipboardText) {
        addTextToCanvas(directClipboardText)
        return true
      }

      return false
    },
    [
      addImageToCanvas,
      addImagesToCanvas,
      addTextToCanvas,
      handleFile,
      readClipboardTextItem,
      readFileAsDataURL
    ]
  )

  const handleNavigatorClipboardPaste = useCallback(async () => {
    if (typeof navigator === 'undefined' || !navigator.clipboard) {
      return false
    }

    try {
      if (typeof navigator.clipboard.read === 'function') {
        const clipItems = await navigator.clipboard.read()
        const imageClipItems = clipItems.flatMap((clipItem) =>
          clipItem.types
            .filter((type) => type.startsWith('image/'))
            .map((type) => ({ clipItem, type }))
        )
        if (imageClipItems.length > 0) {
          const imageSources: Array<{ src: string; fileName?: string; sizeBytes?: number }> = []
          for (const [index, { clipItem, type }] of imageClipItems.entries()) {
            const blob = await clipItem.getType(type)
            const extension = type.split('/')[1]?.split('+')[0]?.trim() || 'png'
            const file = new File([blob], `pasted-${index + 1}.${extension}`, { type: blob.type })
            imageSources.push({
              src: await readFileAsDataURL(file),
              fileName: file.name,
              sizeBytes: file.size
            })
          }

          if (imageSources.length === 1) {
            await addImageToCanvas(imageSources[0].src, {
              fileName: imageSources[0].fileName,
              sizeBytes: imageSources[0].sizeBytes
            })
          } else if (imageSources.length > 1) {
            await addImagesToCanvas(imageSources)
          }
          return true
        }

        const navigatorClipboardFiles: File[] = []
        let pastedFileIndex = 1
        for (const clipItem of clipItems) {
          for (const type of clipItem.types) {
            if (type.startsWith('image/') || type === 'text/plain' || type === 'text/html') {
              continue
            }

            const blob = await clipItem.getType(type)
            const file = normalizeClipboardFile(
              new File([blob], '', { type: blob.type || type }),
              type,
              pastedFileIndex++
            )
            if (isSupportedClipboardFile(file, type)) {
              navigatorClipboardFiles.push(file)
            }
          }
        }

        if (navigatorClipboardFiles.length > 0) {
          for (const file of navigatorClipboardFiles) {
            await handleFile(file)
          }
          return true
        }

        for (const clipItem of clipItems) {
          const plainText = clipItem.types.includes('text/plain')
            ? await (await clipItem.getType('text/plain')).text()
            : ''

          if (plainText.trim()) {
            addTextToCanvas(plainText.trim())
            return true
          }

          if (clipItem.types.includes('text/html')) {
            const htmlText = normalizeClipboardHtmlText(
              await (await clipItem.getType('text/html')).text()
            )
            if (htmlText.trim()) {
              addTextToCanvas(htmlText.trim())
              return true
            }
          }
        }
      }
    } catch {
      // Ignore clipboard item access failures and continue with readText/native fallbacks.
    }

    try {
      if (typeof navigator.clipboard.readText === 'function') {
        const text = await navigator.clipboard.readText()
        if (text.trim()) {
          addTextToCanvas(text.trim())
          return true
        }
      }
    } catch {
      // Ignore plain-text clipboard access failures and continue with native fallbacks.
    }

    return false
  }, [addImageToCanvas, addImagesToCanvas, addTextToCanvas, handleFile, readFileAsDataURL])

  const handleNativeClipboardPaste = useCallback(async () => {
    try {
      const hyperSvc = api().svcHyper
      const nativeClipboardImage = await hyperSvc.readClipboardImage({})
      if (nativeClipboardImage.success && nativeClipboardImage.data) {
        const mimeType = nativeClipboardImage.mimeType?.trim() || 'image/png'
        const extension = mimeType.split('/')[1]?.split('+')[0]?.trim() || 'png'
        const fileBytes = Uint8Array.from(nativeClipboardImage.data)
        const file = new File([fileBytes], `pasted-native.${extension}`, {
          type: mimeType
        })

        await addImageToCanvas(await readFileAsDataURL(file), {
          fileName: file.name,
          sizeBytes: file.size
        })
        return true
      }

      const nativeClipboardText = await hyperSvc.readClipboardText({})
      if (nativeClipboardText.text.trim()) {
        addTextToCanvas(nativeClipboardText.text.trim())
        return true
      }

      if (typeof hyperSvc.readClipboardHtml === 'function') {
        const nativeClipboardHtml = await hyperSvc.readClipboardHtml({})
        const htmlText = normalizeClipboardHtmlText(nativeClipboardHtml.html)
        if (htmlText.trim()) {
          addTextToCanvas(htmlText.trim())
          return true
        }
      }
    } catch {
      // Ignore native clipboard access failures and continue.
    }

    return false
  }, [addImageToCanvas, addTextToCanvas, readFileAsDataURL])

  const handlePasteFromClipboard = useCallback(
    async (event?: ClipboardEvent) => {
      if (!shouldRoutePasteToCanvas()) {
        return false
      }

      const handledClipboardData = await handleClipboardData(event?.clipboardData)
      if (handledClipboardData) {
        handledPasteCounterRef.current += 1
        if (pasteProxyRef.current) {
          pasteProxyRef.current.value = ''
        }
        event?.preventDefault()
        event?.stopImmediatePropagation()
        focusCanvasStage()
        return true
      }

      const handledNavigatorClipboard = await handleNavigatorClipboardPaste()
      if (handledNavigatorClipboard) {
        handledPasteCounterRef.current += 1
        if (pasteProxyRef.current) {
          pasteProxyRef.current.value = ''
        }
        event?.preventDefault()
        event?.stopImmediatePropagation()
        focusCanvasStage()
        return true
      }

      const handledNativeClipboard = await handleNativeClipboardPaste()
      if (handledNativeClipboard) {
        handledPasteCounterRef.current += 1
        if (pasteProxyRef.current) {
          pasteProxyRef.current.value = ''
        }
        event?.preventDefault()
        event?.stopImmediatePropagation()
        focusCanvasStage()
        return true
      }

      return false
    },
    [
      focusCanvasStage,
      handleClipboardData,
      handleNavigatorClipboardPaste,
      handleNativeClipboardPaste,
      shouldRoutePasteToCanvas
    ]
  )

  useEffect(() => {
    const handlePaste = async (event: ClipboardEvent) => {
      if (manualPasteFallbackInFlightRef.current) {
        event.preventDefault()
        event.stopImmediatePropagation()
        return
      }

      if (!shouldRoutePasteToCanvas()) {
        return
      }

      // Claim the browser paste event immediately so downstream document-level
      // listeners (for example the Agent composer) cannot consume the same
      // clipboard payload before async clipboard processing finishes.
      event.preventDefault()
      event.stopImmediatePropagation()
      awaitingKeyboardPasteEventRef.current = false
      await handlePasteFromClipboard(event)
    }

    window.addEventListener('paste', handlePaste, true)
    return () => window.removeEventListener('paste', handlePaste, true)
  }, [handlePasteFromClipboard, shouldRoutePasteToCanvas])

  useEffect(() => {
    const handlePasteShortcut = (event: KeyboardEvent) => {
      if (!isPasteShortcut(event)) {
        return
      }

      const active = document.activeElement
      const isPasteProxyFocused = isCanvasPasteProxyElement(active, pasteProxyRef.current)
      if (isEditableElement(active) && !isPasteProxyFocused) {
        return
      }

      if (hasActiveQuickAppImagePasteTarget()) {
        return
      }

      const pasteProxy = pasteProxyRef.current
      if (pasteProxy) {
        const handledCounter = handledPasteCounterRef.current
        awaitingKeyboardPasteEventRef.current = true
        pasteProxy.focus({ preventScroll: true })
        pasteProxy.select()

        window.setTimeout(() => {
          if (!awaitingKeyboardPasteEventRef.current) {
            return
          }
          if (handledPasteCounterRef.current !== handledCounter) {
            return
          }

          awaitingKeyboardPasteEventRef.current = false
          manualPasteFallbackInFlightRef.current = true
          void handlePasteFromClipboard().finally(() => {
            manualPasteFallbackInFlightRef.current = false
            if (
              handledPasteCounterRef.current === handledCounter &&
              document.activeElement === pasteProxy
            ) {
              canvasContainerRef.current?.focus({ preventScroll: true })
            }
          })
        }, 40)
        return
      }

      event.preventDefault()
      void handlePasteFromClipboard()
    }

    window.addEventListener('keydown', handlePasteShortcut, true)
    return () => window.removeEventListener('keydown', handlePasteShortcut, true)
  }, [canvasContainerRef, canvasOwnsClipboardFocus, handlePasteFromClipboard])

  return {
    handleDrop,
    handleDragOver,
    handleImportFiles,
    handleFile,
    handleToolbarImportClick
  }
}
