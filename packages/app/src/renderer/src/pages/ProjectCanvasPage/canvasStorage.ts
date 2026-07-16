// packages/app/src/renderer/src/pages/ProjectCanvasPage/canvasStorage.ts
// Canvas persistence (IndexedDB) plus export/import helpers.
import type {
  CanvasFileItem,
  CanvasGroup,
  CanvasGroupBranch,
  CanvasImageItem,
  CanvasItem,
  CanvasModel3DItem,
  CanvasVideoItem
} from './types'
import type { CanvasFigmaBinding } from '@shared/figma'
import { restoreGlobalQAppCache } from '../QuickAppPage/components/QAppContext'
import { buildProjectStorageDirName, getProjectById } from '../MainPage/projectStore'
import { normalizeGeneratedRootDirName, unprefixGeneratedRootDirName } from '@shared/projectStorage'
import { getDownloadFileNameFromUrl, normalizeLocalMediaUrl } from '../ChatPage/chatPageShared'
import { normalizeFileMimeType } from '@renderer/utils/fileDisplay'
import { sanitizeFilePart } from './canvasExportNamingUtils'
import { extractMimeTypeFromSourceUrl } from './canvasImageMetadata'

const DB_NAME = 'magicpot-canvas'
const DB_VERSION = 2 // bumped for new blob store
const STORE_NAME = 'canvas-items'
const BLOB_STORE_NAME = 'canvas-blobs' // Stores binary payloads such as 3D models and videos.
const BLOB_STORE_KEY_SEPARATOR = '::canvas::'
const KEY = 'default' // Single-canvas scene; use a fixed key.
const PROJECT_CANVAS_FILENAME = 'project.mpcanvas'
const PROJECT_ASSET_DIRNAME = 'assets'
const PROJECT_CROPPABLE_IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp'])

// Serializable canvas items without DOM-only fields.
type SerializableCanvasItem = Omit<CanvasItem, 'image'> & { image?: never }

interface CanvasPersistedData {
  items: SerializableCanvasItem[]
  groups?: CanvasGroup[]
  groupBranches?: CanvasGroupBranch[]
  figmaBinding?: CanvasFigmaBinding | null
}

type CanvasSnapshot = {
  items: CanvasItem[]
  groups: CanvasGroup[]
  groupBranches: CanvasGroupBranch[]
  figmaBinding: CanvasFigmaBinding | null
}

type ProjectCanvasLocation = {
  projectRootDir: string
  legacyProjectRootDir?: string
  canvasFilename: string
  canvasFullPath: string
  legacyCanvasFullPath?: string
  assetDir: string
}

const normalizeCanvasStorageError = (error: unknown, fallbackMessage: string): Error => {
  if (error instanceof Error) {
    return error
  }

  if (typeof error === 'string' && error.trim()) {
    return new Error(error)
  }

  if (error && typeof error === 'object') {
    try {
      return new Error(JSON.stringify(error))
    } catch {
      return new Error(fallbackMessage)
    }
  }

  return new Error(fallbackMessage)
}

const rejectCanvasStorageError = (
  reject: (reason?: unknown) => void,
  operation: string,
  error: unknown
): void => {
  reject(normalizeCanvasStorageError(error, `[Canvas Storage] ${operation} failed.`))
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME)
      }
      // Add blob storage for persisted binary assets.
      if (!db.objectStoreNames.contains(BLOB_STORE_NAME)) {
        db.createObjectStore(BLOB_STORE_NAME)
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => rejectCanvasStorageError(reject, 'IndexedDB open', request.error)
  })
}

/**
 * Serialize canvas items and drop non-serializable fields such as HTMLImageElement.
 */
function serializeItems(items: CanvasItem[]): SerializableCanvasItem[] {
  return items.map((item) => {
    if (item.type === 'image') {
      const { image, sourceFile, ...rest } = item
      const sourceWidth =
        typeof rest.sourceWidth === 'number' &&
        Number.isFinite(rest.sourceWidth) &&
        rest.sourceWidth > 0
          ? rest.sourceWidth
          : rest.width
      const sourceHeight =
        typeof rest.sourceHeight === 'number' &&
        Number.isFinite(rest.sourceHeight) &&
        rest.sourceHeight > 0
          ? rest.sourceHeight
          : rest.height

      if (
        rest.crop &&
        rest.crop.x === 0 &&
        rest.crop.y === 0 &&
        rest.crop.width === sourceWidth &&
        rest.crop.height === sourceHeight
      ) {
        const { crop, ...normalized } = rest
        return normalized as SerializableCanvasItem
      }

      return rest as SerializableCanvasItem
    }
    if (item.type === 'model3d') {
      const { deferRender, sourceFile, ...rest } = item as CanvasItem & {
        deferRender?: boolean
        sourceFile?: Blob
      }
      return rest as SerializableCanvasItem
    }
    if (item.type === 'video' || item.type === 'file') {
      const { sourceFile, ...rest } = item
      return rest as SerializableCanvasItem
    }
    return item as SerializableCanvasItem
  })
}

// Blob persistence helpers.

/**
 * Normalize legacy persisted payload shapes.
 */
function extractPersistedCanvasData(
  persisted: CanvasPersistedData | SerializableCanvasItem[] | undefined
): {
  items: SerializableCanvasItem[]
  groups: CanvasGroup[]
  groupBranches: CanvasGroupBranch[]
  figmaBinding: CanvasFigmaBinding | null
} {
  if (Array.isArray(persisted)) {
    return {
      items: persisted,
      groups: [],
      groupBranches: [],
      figmaBinding: null
    }
  }

  return {
    items: persisted?.items || [],
    groups: persisted?.groups || [],
    groupBranches: persisted?.groupBranches || [],
    figmaBinding: persisted?.figmaBinding || null
  }
}

type BlobWriteEntry = {
  key: string
  data: ArrayBuffer
  mimeType: string
}

type ResolvedCanvasBinaryAsset = BlobWriteEntry & {
  fileName: string
  projectAssetRef?: string
}

type NormalizedCanvasImageCrop = {
  x: number
  y: number
  width: number
  height: number
}

type CroppedProjectImageAsset = ResolvedCanvasBinaryAsset & {
  pixelWidth: number
  pixelHeight: number
}

type CanvasFileStorageMode = 'embedded' | 'project'

type CanvasFileRestoreOptions = {
  restoreQAppState?: boolean
  persistEmbeddedAssetsToIndexedDb?: boolean
  canvasBaseDir?: string
}

type BlobPersistableCanvasItem =
  | CanvasImageItem
  | CanvasModel3DItem
  | CanvasVideoItem
  | CanvasFileItem

type SerializableBlobPersistableCanvasItem = SerializableCanvasItem & {
  type: 'image' | 'model3d' | 'video' | 'file'
  src?: string
  fileName?: string
  textures?: Record<string, string>
}

function isBlobPersistableCanvasItem(
  item: CanvasItem | SerializableCanvasItem
): item is BlobPersistableCanvasItem | SerializableBlobPersistableCanvasItem {
  return (
    item.type === 'image' ||
    item.type === 'model3d' ||
    item.type === 'video' ||
    item.type === 'file'
  )
}

function hasBlobLikeCanvasSrc(
  item: BlobPersistableCanvasItem | SerializableBlobPersistableCanvasItem
): boolean {
  return typeof item.src === 'string' && item.src.startsWith('blob:')
}

function hasLocallyPersistableCanvasSrc(
  item: BlobPersistableCanvasItem | SerializableBlobPersistableCanvasItem
): boolean {
  return (
    typeof item.src === 'string' &&
    (item.src.startsWith('blob:') || resolveLocalFilePathFromSource(item.src) !== null)
  )
}

function getScopedCanvasBlobKey(storeKey: string, itemKey: string): string {
  return `${storeKey}${BLOB_STORE_KEY_SEPARATOR}${itemKey}`
}

function getScopedCanvasBlobKeyPrefix(storeKey: string): string {
  return `${storeKey}${BLOB_STORE_KEY_SEPARATOR}`
}

function getLogicalCanvasBlobKey(storeKey: string, storageKey: string): string | null {
  const prefix = getScopedCanvasBlobKeyPrefix(storeKey)
  return storageKey.startsWith(prefix) ? storageKey.slice(prefix.length) : null
}

async function resolveCanvasBinaryAssetFromSourceFile(
  item: BlobPersistableCanvasItem,
  key: string,
  fileName: string,
  fallbackMimeType: string
): Promise<ResolvedCanvasBinaryAsset | null> {
  const sourceFile = 'sourceFile' in item ? item.sourceFile : undefined
  if (!sourceFile) {
    return null
  }

  try {
    return {
      key,
      data: await readBlobDataAsArrayBuffer(sourceFile),
      mimeType: sourceFile.type || normalizeFileMimeType(fileName, undefined, fallbackMimeType),
      fileName
    }
  } catch (error) {
    console.warn('[Canvas Storage] Failed to read source file asset:', key, error)
    return null
  }
}

/**
 * Persist multiple blob entries in a single IndexedDB transaction.
 */
async function saveBlobEntries(
  db: IDBDatabase,
  storeKey: string,
  entries: readonly BlobWriteEntry[]
): Promise<void> {
  if (entries.length === 0) return

  return new Promise((resolve, reject) => {
    const tx = db.transaction(BLOB_STORE_NAME, 'readwrite')
    const store = tx.objectStore(BLOB_STORE_NAME)
    for (const entry of entries) {
      store.put(
        { data: entry.data, mimeType: entry.mimeType },
        getScopedCanvasBlobKey(storeKey, entry.key)
      )
    }
    tx.oncomplete = () => resolve()
    tx.onerror = () => rejectCanvasStorageError(reject, 'blob batch save transaction', tx.error)
  })
}

function cloneUint8ArrayBuffer(source: Uint8Array): ArrayBuffer {
  return source.slice().buffer
}

async function readBlobDataAsArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  const blobWithReaders = blob as Blob & {
    arrayBuffer?: () => Promise<ArrayBuffer>
  }
  if (typeof blobWithReaders.arrayBuffer === 'function') {
    return await blobWithReaders.arrayBuffer()
  }

  return await new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        resolve(new TextEncoder().encode(reader.result).buffer)
        return
      }
      resolve(reader.result as ArrayBuffer)
    }
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read blob data.'))
    reader.readAsArrayBuffer(blob)
  })
}

function resolveDataUriAsset(
  dataUri: string
): { data: ArrayBuffer; mimeType: string | null } | null {
  const match = dataUri.match(/^data:([^;,]+)?(;base64)?,(.*)$/i)
  if (!match) {
    return null
  }

  const mimeType = match[1]?.trim() || null
  const payload = match[3] || ''
  if (match[2]) {
    return {
      data: base64ToArrayBuffer(payload),
      mimeType
    }
  }

  const decoded = decodeURIComponent(payload)
  return {
    data: new TextEncoder().encode(decoded).buffer,
    mimeType
  }
}

function resolveLocalFilePathFromSource(sourceUrl: string): string | null {
  const normalized = normalizeLocalMediaUrl(sourceUrl).trim()
  if (!normalized) {
    return null
  }

  if (normalized.startsWith('local-media:///')) {
    return decodeURIComponent(normalized.slice('local-media:///'.length))
  }

  if (normalized.startsWith('local-media://')) {
    return decodeURIComponent(normalized.slice('local-media://'.length).replace(/^\/+/, ''))
  }

  if (normalized.startsWith('file:///')) {
    return decodeURIComponent(normalized.slice('file:///'.length))
  }

  if (normalized.startsWith('file://')) {
    return decodeURIComponent(normalized.slice('file://'.length).replace(/^\/+/, ''))
  }

  return null
}

async function readBinarySourceFromLocalFile(
  sourceUrl: string
): Promise<{ data: ArrayBuffer; mimeType: string | null } | null> {
  const fullPath = resolveLocalFilePathFromSource(sourceUrl)
  if (!fullPath || !window.api?.svcFs) {
    return null
  }

  try {
    const { data } = await window.api.svcFs.readFileFromPath({ fullPath })
    return {
      data: cloneUint8ArrayBuffer(data),
      mimeType: null
    }
  } catch (error) {
    console.warn('[Canvas Storage] Failed to read local file asset:', fullPath, error)
    return null
  }
}

async function fetchSourceAsArrayBuffer(
  sourceUrl: string
): Promise<{ data: ArrayBuffer; mimeType: string | null } | null> {
  try {
    const response = await fetch(normalizeLocalMediaUrl(sourceUrl))
    if (!response.ok) {
      return null
    }

    if (typeof response.blob !== 'function') {
      return {
        data: await response.arrayBuffer(),
        mimeType: null
      }
    }

    const blob = await response.blob()
    return {
      data: await readBlobDataAsArrayBuffer(blob),
      mimeType: blob.type || null
    }
  } catch {
    return null
  }
}

function readBlobStoreEntry(
  store: IDBObjectStore,
  key: string
): Promise<{ data: ArrayBuffer; mimeType: string } | undefined> {
  return new Promise((resolve, reject) => {
    const request = store.get(key)
    request.onsuccess = () =>
      resolve(request.result as { data: ArrayBuffer; mimeType: string } | undefined)
    request.onerror = () =>
      rejectCanvasStorageError(reject, `embedded asset load request for ${key}`, request.error)
  })
}

async function readIndexedDbBinaryAsset(
  key: string,
  storeKey?: string
): Promise<{ data: ArrayBuffer; mimeType: string } | null> {
  try {
    const db = await openDB()
    const tx = db.transaction(BLOB_STORE_NAME, 'readonly')
    const store = tx.objectStore(BLOB_STORE_NAME)
    const scopedResultPromise = storeKey
      ? readBlobStoreEntry(store, getScopedCanvasBlobKey(storeKey, key))
      : Promise.resolve(undefined)
    const legacyResultPromise = readBlobStoreEntry(store, key)
    const [scopedResult, legacyResult] = await Promise.all([
      scopedResultPromise,
      legacyResultPromise
    ])
    const result = scopedResult || legacyResult
    db.close()

    return result ? { data: result.data, mimeType: result.mimeType } : null
  } catch {
    return null
  }
}

async function resolveCanvasBinaryAsset(
  key: string,
  sourceUrl: string | undefined,
  fileName: string,
  fallbackMimeType: string,
  storeKey?: string,
  options: { allowIndexedDbFallback?: boolean } = {}
): Promise<ResolvedCanvasBinaryAsset | null> {
  if (!sourceUrl) {
    return null
  }

  const fromDataUri = sourceUrl.startsWith('data:') ? resolveDataUriAsset(sourceUrl) : null
  const fromLocalFile = fromDataUri ? null : await readBinarySourceFromLocalFile(sourceUrl)
  const fromFetch = fromDataUri || fromLocalFile ? null : await fetchSourceAsArrayBuffer(sourceUrl)
  const fromIndexedDb =
    fromDataUri || fromLocalFile || fromFetch || !options.allowIndexedDbFallback
      ? null
      : await readIndexedDbBinaryAsset(key, storeKey)
  const resolved = fromDataUri || fromLocalFile || fromFetch || fromIndexedDb

  if (!resolved) {
    return null
  }

  return {
    key,
    data: resolved.data,
    mimeType: resolved.mimeType || fallbackMimeType,
    fileName
  }
}

async function resolveCanvasBinaryAssetFromComfyFileItem(
  item: BlobPersistableCanvasItem,
  key: string,
  fileName: string,
  fallbackMimeType: string
): Promise<ResolvedCanvasBinaryAsset | null> {
  const fileItem = item.type === 'image' || item.type === 'video' ? item.fileItem : undefined
  if (!fileItem?.filename || !window.api?.svcComfy) {
    return null
  }

  try {
    const response = await window.api.svcComfy.getView(fileItem)
    return {
      key,
      data: cloneUint8ArrayBuffer(response.result),
      mimeType: normalizeFileMimeType(fileItem.filename, undefined, fallbackMimeType),
      fileName
    }
  } catch (error) {
    console.warn('[Canvas Storage] Failed to resolve Comfy-backed canvas asset:', key, error)
    return null
  }
}

async function resolveCanvasBinaryAssetForItem(
  item: BlobPersistableCanvasItem,
  key: string,
  sourceUrl: string | undefined,
  fileName: string,
  fallbackMimeType: string,
  storeKey?: string,
  options?: { allowIndexedDbFallback?: boolean }
): Promise<ResolvedCanvasBinaryAsset | null> {
  return (
    (await resolveCanvasBinaryAssetFromSourceFile(item, key, fileName, fallbackMimeType)) ||
    (await resolveCanvasBinaryAsset(
      key,
      sourceUrl,
      fileName,
      fallbackMimeType,
      storeKey,
      options
    )) ||
    (await resolveCanvasBinaryAssetFromComfyFileItem(item, key, fileName, fallbackMimeType))
  )
}

function resolveCanvasImageSourceSize(
  item: Pick<CanvasImageItem, 'sourceWidth' | 'sourceHeight' | 'width' | 'height'>
): { width: number; height: number } {
  const width =
    typeof item.sourceWidth === 'number' &&
    Number.isFinite(item.sourceWidth) &&
    item.sourceWidth > 0
      ? item.sourceWidth
      : item.width
  const height =
    typeof item.sourceHeight === 'number' &&
    Number.isFinite(item.sourceHeight) &&
    item.sourceHeight > 0
      ? item.sourceHeight
      : item.height

  return {
    width: Math.max(0, width),
    height: Math.max(0, height)
  }
}

function normalizeProjectCanvasImageCrop(
  item: Pick<CanvasImageItem, 'crop' | 'sourceWidth' | 'sourceHeight' | 'width' | 'height'>
): NormalizedCanvasImageCrop | null {
  if (!item.crop) {
    return null
  }

  const { width: sourceWidth, height: sourceHeight } = resolveCanvasImageSourceSize(item)
  if (sourceWidth <= 0 || sourceHeight <= 0) {
    return null
  }

  const { crop } = item
  if (
    !Number.isFinite(crop.x) ||
    !Number.isFinite(crop.y) ||
    !Number.isFinite(crop.width) ||
    !Number.isFinite(crop.height) ||
    crop.width <= 0 ||
    crop.height <= 0
  ) {
    return null
  }

  const x1 = Math.min(sourceWidth, Math.max(0, crop.x))
  const y1 = Math.min(sourceHeight, Math.max(0, crop.y))
  const x2 = Math.min(sourceWidth, Math.max(0, crop.x + crop.width))
  const y2 = Math.min(sourceHeight, Math.max(0, crop.y + crop.height))

  if (x2 <= x1 || y2 <= y1) {
    return null
  }

  if (x1 === 0 && y1 === 0 && x2 === sourceWidth && y2 === sourceHeight) {
    return null
  }

  return {
    x: x1,
    y: y1,
    width: x2 - x1,
    height: y2 - y1
  }
}

function resolveProjectCroppedImageMimeType(
  item: Pick<CanvasImageItem, 'fileName' | 'src'>,
  resolvedFileName: string
): string | null {
  const mimeType = normalizeFileMimeType(
    resolvedFileName,
    extractMimeTypeFromSourceUrl(item.src),
    'image/png'
  ).toLowerCase()

  return PROJECT_CROPPABLE_IMAGE_MIME_TYPES.has(mimeType) ? mimeType : null
}

function ensureProjectImageFileNameMatchesMimeType(fileName: string, mimeType: string): string {
  const preferredExtension =
    mimeType === 'image/jpeg' ? '.jpg' : mimeType === 'image/webp' ? '.webp' : '.png'
  const trimmed = fileName.trim()
  const fallbackBase = trimmed || 'canvas-image'
  const currentMimeType = normalizeFileMimeType(trimmed)
  if (currentMimeType === mimeType) {
    return trimmed
  }

  const lastDot = fallbackBase.lastIndexOf('.')
  const baseName = lastDot > 0 ? fallbackBase.slice(0, lastDot) : fallbackBase
  return `${baseName}${preferredExtension}`
}

function loadImageFromBlob(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(blob)
    const image = new Image()
    const cleanup = () => {
      image.onload = null
      image.onerror = null
      URL.revokeObjectURL(objectUrl)
    }

    image.onload = () => {
      cleanup()
      resolve(image)
    }
    image.onerror = () => {
      cleanup()
      reject(new Error('Failed to decode cropped canvas image asset.'))
    }
    image.src = objectUrl
  })
}

async function readBlobAsArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  const blobWithArrayBuffer = blob as Blob & { arrayBuffer?: () => Promise<ArrayBuffer> }
  if (typeof blobWithArrayBuffer.arrayBuffer === 'function') {
    return await blobWithArrayBuffer.arrayBuffer()
  }

  return await new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as ArrayBuffer)
    reader.onerror = () =>
      reject(reader.error ?? new Error('Failed to read cropped canvas blob as ArrayBuffer.'))
    reader.readAsArrayBuffer(blob)
  })
}

async function createProjectCroppedImageAsset(
  sourceAsset: ResolvedCanvasBinaryAsset,
  crop: NormalizedCanvasImageCrop,
  mimeType: string,
  fileName: string
): Promise<CroppedProjectImageAsset | null> {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') {
    return null
  }

  try {
    const sourceMimeType =
      sourceAsset.mimeType.startsWith('image/') && sourceAsset.mimeType
        ? sourceAsset.mimeType
        : mimeType
    const image = await loadImageFromBlob(new Blob([sourceAsset.data], { type: sourceMimeType }))
    const canvas = document.createElement('canvas')
    const pixelWidth = Math.max(1, Math.round(crop.width))
    const pixelHeight = Math.max(1, Math.round(crop.height))
    canvas.width = pixelWidth
    canvas.height = pixelHeight

    const context = canvas.getContext('2d')
    if (!context || typeof canvas.toBlob !== 'function') {
      return null
    }

    context.drawImage(image, crop.x, crop.y, crop.width, crop.height, 0, 0, pixelWidth, pixelHeight)

    const croppedBlob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((blob) => resolve(blob), mimeType)
    })
    if (!croppedBlob) {
      return null
    }

    return {
      key: sourceAsset.key,
      fileName,
      data: await readBlobAsArrayBuffer(croppedBlob),
      mimeType: croppedBlob.type || mimeType,
      pixelWidth,
      pixelHeight
    }
  } catch (error) {
    console.warn('[Canvas Storage] Failed to flatten cropped project image asset:', error)
    return null
  }
}

async function resolveProjectStorageRootPath(): Promise<string | null> {
  if (!window.api?.svcState || !window.path || typeof window.path.join !== 'function') {
    return null
  }

  try {
    if (typeof window.api.svcState.getConfig === 'function') {
      const { config } = await window.api.svcState.getConfig({})
      const configuredDir = config.download_dir?.trim()
      if (configuredDir) {
        return configuredDir
      }
    }
  } catch (error) {
    console.warn('[Canvas Storage] Unable to resolve configured project root path:', error)
  }

  try {
    const { state } = await window.api.svcState.getUserDataDirectoryState({})
    return state.projectRoot
  } catch (error) {
    console.warn('[Canvas Storage] Unable to resolve fallback project root path:', error)
    return null
  }
}

function resolveProjectStorageDirName(storeKey: string): string {
  const project = getProjectById(storeKey)
  const normalizedStoredDirName = project?.storageDirName
    ? normalizeGeneratedRootDirName(project.storageDirName)
    : ''
  return normalizedStoredDirName || buildProjectStorageDirName(project?.name || storeKey, storeKey)
}

function resolveLegacyProjectStorageDirName(storeKey: string): string | null {
  const currentName = resolveProjectStorageDirName(storeKey)
  const legacyName = unprefixGeneratedRootDirName(currentName)
  return legacyName && legacyName !== currentName ? legacyName : null
}

export async function getProjectCanvasLocation(
  storeKey: string
): Promise<ProjectCanvasLocation | null> {
  const rootPath = await resolveProjectStorageRootPath()
  if (!rootPath || !window.path || typeof window.path.join !== 'function') {
    return null
  }

  const projectRootDir = window.path.join(rootPath, resolveProjectStorageDirName(storeKey))
  const legacyStorageDirName = resolveLegacyProjectStorageDirName(storeKey)
  const legacyProjectRootDir = legacyStorageDirName
    ? window.path.join(rootPath, legacyStorageDirName)
    : undefined
  return {
    projectRootDir,
    ...(legacyProjectRootDir ? { legacyProjectRootDir } : {}),
    canvasFilename: PROJECT_CANVAS_FILENAME,
    canvasFullPath: window.path.join(projectRootDir, PROJECT_CANVAS_FILENAME),
    ...(legacyProjectRootDir
      ? { legacyCanvasFullPath: window.path.join(legacyProjectRootDir, PROJECT_CANVAS_FILENAME) }
      : {}),
    assetDir: window.path.join(projectRootDir, PROJECT_ASSET_DIRNAME)
  }
}

function buildProjectAssetFileName(assetKey: string, rawFileName: string): string {
  const fallbackName = rawFileName.trim() || assetKey
  const extensionMatch = fallbackName.match(/(\.[^.]+)$/)
  const extension = extensionMatch?.[1] || ''
  const baseName = extension ? fallbackName.slice(0, -extension.length) : fallbackName
  return `${sanitizeFilePart(assetKey.replace(/::/g, '__'))}__${sanitizeFilePart(baseName)}${extension}`
}

function normalizeComparablePath(value: string): string {
  return value.replace(/[\\/]+/g, '/').toLowerCase()
}

function toLocalMediaUrl(fullPath: string): string {
  return `local-media:///${fullPath.replace(/[\\/]+/g, '/').replace(/^\/+/, '')}`
}

function normalizeProjectAssetRef(assetRef: string): string {
  return assetRef
    .replace(/[\\/]+/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
}

function resolveProjectAssetCategory(
  itemType: BlobPersistableCanvasItem['type'] | 'texture'
): string {
  switch (itemType) {
    case 'image':
      return 'images'
    case 'video':
      return 'videos'
    case 'model3d':
      return 'models'
    case 'file':
      return 'files'
    case 'texture':
      return 'textures'
    default:
      return 'misc'
  }
}

function buildProjectAssetRef(
  assetKey: string,
  rawFileName: string,
  itemType: BlobPersistableCanvasItem['type'] | 'texture'
): string {
  return `${PROJECT_ASSET_DIRNAME}/${resolveProjectAssetCategory(itemType)}/${buildProjectAssetFileName(assetKey, rawFileName)}`
}

function buildProjectAssetRefMap(items: CanvasItem[]): Map<string, string> {
  const refs = new Map<string, string>()

  for (const item of items) {
    if (!isBlobPersistableCanvasItem(item) || !item.src) {
      continue
    }

    const resolvedFileName = resolveCanvasAssetFileName(item)
    refs.set(item.id, buildProjectAssetRef(item.id, resolvedFileName, item.type))

    if (item.type === 'model3d' && item.textures) {
      for (const textureName of Object.keys(item.textures)) {
        const textureKey = getModelTextureKey(item.id, textureName)
        refs.set(textureKey, buildProjectAssetRef(textureKey, textureName, 'texture'))
      }
    }
  }

  return refs
}

function isRelativeCanvasAssetReference(sourceUrl: string): boolean {
  const normalized = sourceUrl.trim()
  if (!normalized) {
    return false
  }

  if (
    normalized.startsWith('blob:') ||
    normalized.startsWith('data:') ||
    normalized.startsWith('local-media://') ||
    normalized.startsWith('file://')
  ) {
    return false
  }

  if (/^[a-z]+:\/\//i.test(normalized) || /^[a-z]+:/i.test(normalized)) {
    return false
  }

  if (/^[a-z]:[\\/]/i.test(normalized) || /^[\\/]/.test(normalized)) {
    return false
  }

  return true
}

function resolveProjectAssetFullPath(canvasBaseDir: string, assetRef: string): string | null {
  if (!window.path || typeof window.path.join !== 'function') {
    return null
  }

  const normalizedRef = normalizeProjectAssetRef(assetRef)
  if (!normalizedRef) {
    return null
  }

  return window.path.join(canvasBaseDir, ...normalizedRef.split('/').filter(Boolean))
}

function sourceAlreadyMatchesProjectAsset(
  sourceUrl: string,
  projectAssetFullPath: string
): boolean {
  const localFilePath = resolveLocalFilePathFromSource(sourceUrl)
  if (!localFilePath) {
    return false
  }

  return normalizeComparablePath(localFilePath) === normalizeComparablePath(projectAssetFullPath)
}

async function writeProjectAssetFiles(
  assetDir: string,
  assetEntries: readonly ResolvedCanvasBinaryAsset[]
): Promise<void> {
  if (!window.api?.svcFs || !window.path) {
    return
  }

  await Promise.all(
    assetEntries.map((entry) => {
      const relativeRef = entry.projectAssetRef
        ? normalizeProjectAssetRef(entry.projectAssetRef)
        : buildProjectAssetFileName(entry.key, entry.fileName)
      const relativeSegments = relativeRef
        .split('/')
        .filter(Boolean)
        .filter((segment, index) => !(index === 0 && segment === PROJECT_ASSET_DIRNAME))
      const fallbackFilename = buildProjectAssetFileName(entry.key, entry.fileName)
      const filename = relativeSegments.pop() || fallbackFilename
      const outputPath =
        relativeSegments.length > 0 ? window.path.join(assetDir, ...relativeSegments) : assetDir

      return window.api.svcFs.saveImageToPath({
        image: new Uint8Array(entry.data),
        outputPath,
        filename
      })
    })
  )
}

async function saveProjectCanvasFile(
  storeKey: string,
  items: CanvasItem[],
  groups: CanvasGroup[],
  groupBranches: CanvasGroupBranch[],
  figmaBinding: CanvasFigmaBinding | null,
  seededAssetEntries: readonly BlobWriteEntry[] = []
): Promise<boolean> {
  const location = await getProjectCanvasLocation(storeKey)
  if (!location || !window.api?.svcFs) {
    return false
  }

  try {
    const { canvasFileData, assetEntries } = await buildProjectCanvasFileData(
      items,
      location.projectRootDir,
      groups,
      groupBranches,
      figmaBinding,
      seededAssetEntries,
      storeKey
    )

    await writeProjectAssetFiles(location.assetDir, assetEntries)
    await window.api.svcFs.writeTextFile({
      outputPath: location.projectRootDir,
      filename: location.canvasFilename,
      content: JSON.stringify(canvasFileData)
    })
    return true
  } catch (error) {
    console.warn('[Canvas Storage] Failed to save project canvas file:', error)
    return false
  }
}

async function readCanvasItemsFromProjectFile(
  canvasFullPath: string
): Promise<CanvasSnapshot | null> {
  if (!window.api?.svcFs) {
    return null
  }

  try {
    const { content } = await window.api.svcFs.readTextFile({ fullPath: canvasFullPath })
    const parsed = JSON.parse(content) as CanvasFileData
    const canvasBaseDir =
      window.path && typeof window.path.dirname === 'function'
        ? window.path.dirname(canvasFullPath)
        : undefined
    return await restoreCanvasFileData(parsed, {
      restoreQAppState: false,
      persistEmbeddedAssetsToIndexedDb: true,
      canvasBaseDir
    })
  } catch (error) {
    if (isMissingMirrorFileError(error)) {
      return null
    }

    console.warn('[Canvas Storage] Failed to load project canvas file:', error)
    return null
  }
}

async function loadBlobUrlMap(
  db: IDBDatabase,
  storeKey: string,
  itemIds: readonly string[]
): Promise<Map<string, string>> {
  if (itemIds.length === 0) return new Map()

  const uniqueItemIds = [...new Set(itemIds)]
  const tx = db.transaction(BLOB_STORE_NAME, 'readonly')
  const store = tx.objectStore(BLOB_STORE_NAME)
  const restoredEntries = await Promise.all(
    uniqueItemIds.map(
      (itemId) =>
        new Promise<readonly [string, string] | null>((resolve, reject) => {
          const scopedRequest = store.get(getScopedCanvasBlobKey(storeKey, itemId))
          const legacyRequest = store.get(itemId)
          let scopedResult: { data: ArrayBuffer; mimeType: string } | undefined
          let legacyResult: { data: ArrayBuffer; mimeType: string } | undefined
          let completedRequests = 0
          const finish = () => {
            completedRequests += 1
            if (completedRequests < 2) {
              return
            }
            const result = scopedResult || legacyResult
            if (!result) {
              resolve(null)
              return
            }

            const blob = new Blob([result.data], { type: result.mimeType })
            resolve([itemId, URL.createObjectURL(blob)] as const)
          }
          scopedRequest.onsuccess = () => {
            scopedResult = scopedRequest.result as
              | { data: ArrayBuffer; mimeType: string }
              | undefined
            finish()
          }
          legacyRequest.onsuccess = () => {
            legacyResult = legacyRequest.result as
              | { data: ArrayBuffer; mimeType: string }
              | undefined
            finish()
          }
          scopedRequest.onerror = () =>
            rejectCanvasStorageError(
              reject,
              `scoped blob load request for ${itemId}`,
              scopedRequest.error
            )
          legacyRequest.onerror = () =>
            rejectCanvasStorageError(
              reject,
              `legacy blob load request for ${itemId}`,
              legacyRequest.error
            )
        })
    )
  )

  return new Map(
    restoredEntries.filter((entry): entry is readonly [string, string] => entry !== null)
  )
}

async function deleteBlobData(db: IDBDatabase, itemId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(BLOB_STORE_NAME, 'readwrite')
    const store = tx.objectStore(BLOB_STORE_NAME)
    store.delete(itemId)
    tx.oncomplete = () => resolve()
    tx.onerror = () =>
      rejectCanvasStorageError(reject, `blob delete transaction for ${itemId}`, tx.error)
  })
}

function restorePersistedCanvasItems(
  data: readonly SerializableCanvasItem[],
  restoredBlobUrls: ReadonlyMap<string, string>
): CanvasItem[] {
  const restored: CanvasItem[] = []

  for (const item of data) {
    const embeddedUrl = isBlobPersistableCanvasItem(item)
      ? (restoredBlobUrls.get(item.id) ?? null)
      : null
    if (
      isBlobPersistableCanvasItem(item) &&
      (embeddedUrl || !item.src || hasBlobLikeCanvasSrc(item))
    ) {
      try {
        if (embeddedUrl) {
          let restoredItem = { ...item, src: embeddedUrl } as CanvasItem

          if (item.type === 'model3d' && item.textures) {
            const restoredTextures: Record<string, string> = {}
            for (const texName of Object.keys(item.textures)) {
              const texKey = getModelTextureKey(item.id, texName)
              const texUrl = restoredBlobUrls.get(texKey) ?? null
              if (texUrl) {
                restoredTextures[texName] = texUrl
              }
            }

            if (Object.keys(restoredTextures).length > 0) {
              restoredItem = { ...restoredItem, textures: restoredTextures } as CanvasItem
            }
          }

          restored.push(restoredItem)
        } else {
          console.warn(`[Canvas Storage] Missing binary data for ${item.type}, skipping:`, item.id)
        }
      } catch {
        console.warn(`[Canvas Storage] Failed to restore ${item.type} blob:`, item.id)
      }
      continue
    }

    restored.push(item as CanvasItem)
  }

  return restored
}

function isMissingMirrorFileError(error: unknown): boolean {
  return error instanceof Error && /file not found/i.test(error.message)
}

async function loadCanvasItemsFromProjectFile(storeKey: string): Promise<CanvasSnapshot | null> {
  const location = await getProjectCanvasLocation(storeKey)
  if (!location) {
    return null
  }

  return (
    (await readCanvasItemsFromProjectFile(location.canvasFullPath)) ||
    (location.legacyCanvasFullPath
      ? await readCanvasItemsFromProjectFile(location.legacyCanvasFullPath)
      : null)
  )
}

// Guess MIME types.
function guessMimeType(fileName: string): string {
  return normalizeFileMimeType(fileName)
}

function guessTextureMimeType(fileName: string): string {
  const ext = fileName.toLowerCase().split('.').pop() || ''
  return (
    {
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      tga: 'image/x-tga',
      bmp: 'image/bmp',
      webp: 'image/webp',
      gif: 'image/gif',
      tiff: 'image/tiff',
      dds: 'image/vnd-ms.dds',
      hdr: 'image/vnd.radiance',
      exr: 'image/x-exr',
      mtl: 'text/plain',
      mat: 'text/plain'
    }[ext] || 'application/octet-stream'
  )
}

function getModelTextureKey(itemId: string, textureName: string): string {
  return `${itemId}::tex::${textureName}`
}

/**
 * Persist canvas items to IndexedDB.
 * Drop non-serializable fields such as HTMLImageElement.
 * Persist blob-backed image, model, video, and file data when needed.
 */
export async function saveCanvasItems(
  items: CanvasItem[],
  storeKey: string = KEY,
  groups: CanvasGroup[] = [],
  groupBranches: CanvasGroupBranch[] = [],
  figmaBinding: CanvasFigmaBinding | null = null
): Promise<void> {
  try {
    const db = await openDB()

    // 1. Persist blob-backed binary data (image / model3d / video / file).
    const blobItems = items.filter(
      (item): item is BlobPersistableCanvasItem =>
        isBlobPersistableCanvasItem(item) && hasLocallyPersistableCanvasSrc(item)
    )
    const persistedBlobEntries = (
      await Promise.all(
        blobItems.map(async (item) => {
          const resolvedFileName = item.fileName || item.id
          return await resolveCanvasBinaryAssetForItem(
            item,
            item.id,
            item.src,
            resolvedFileName,
            guessMimeType(resolvedFileName),
            storeKey
          )
        })
      )
    ).filter((entry): entry is ResolvedCanvasBinaryAsset => entry !== null)

    // 1.5 Persist blob-backed model texture data.
    const blobTextureSources = items.flatMap((item) => {
      if (item.type !== 'model3d' || !item.textures) return []
      return Object.entries(item.textures)
        .filter(([, texUrl]) => texUrl.startsWith('blob:'))
        .map(([texName, texUrl]) => ({
          key: getModelTextureKey(item.id, texName),
          texName,
          texUrl
        }))
    })
    const persistedTextureEntries = (
      await Promise.all(
        blobTextureSources.map(async ({ key, texName, texUrl }) =>
          resolveCanvasBinaryAsset(key, texUrl, texName, guessTextureMimeType(texName), storeKey)
        )
      )
    ).filter((entry): entry is ResolvedCanvasBinaryAsset => entry !== null)

    const persistedBlobKeys = new Set(persistedBlobEntries.map((entry) => entry.key))
    const missingBlobItemIds = blobItems
      .filter((item) => !persistedBlobKeys.has(item.id))
      .map((item) => item.id)
    const persistedTextureKeys = new Set(persistedTextureEntries.map((entry) => entry.key))
    const missingTextureIds = blobTextureSources
      .filter((source) => !persistedTextureKeys.has(source.key))
      .map((source) => source.key)
    const missingBinaryKeys = [...missingBlobItemIds, ...missingTextureIds]
    if (missingBinaryKeys.length > 0) {
      throw new Error(
        `[Canvas Storage] Refusing to save canvas metadata because binary data could not be persisted: ${missingBinaryKeys.join(', ')}`
      )
    }

    const allBlobEntries = [...persistedBlobEntries, ...persistedTextureEntries]

    await saveBlobEntries(db, storeKey, allBlobEntries)

    // 2. Remove blob entries that are no longer referenced.
    const currentBlobIds = new Set<string>([
      ...blobItems.map((item) => item.id),
      ...persistedTextureEntries.map((entry) => entry.key)
    ])
    try {
      const allBlobKeys = await new Promise<IDBValidKey[]>((resolve, reject) => {
        const tx = db.transaction(BLOB_STORE_NAME, 'readonly')
        const store = tx.objectStore(BLOB_STORE_NAME)
        const req = store.getAllKeys()
        req.onsuccess = () => resolve(req.result)
        req.onerror = () =>
          rejectCanvasStorageError(reject, 'blob key enumeration request', req.error)
      })
      for (const key of allBlobKeys) {
        const k = key as string
        const logicalKey = getLogicalCanvasBlobKey(storeKey, k)
        if (logicalKey === null) {
          continue
        }
        if (currentBlobIds.has(logicalKey)) continue
        await deleteBlobData(db, k)
      }
    } catch {
      // getAllKeys may not be available in very old environments, ignore
    }

    // 3. Save canvas metadata.
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    const locallyPersistedItemIds = new Set(
      persistedBlobEntries.map((entry) => entry.key).filter((key) => !key.includes('::tex::'))
    )
    const persistedItems = serializeItems(items).map((item) => {
      if (
        isBlobPersistableCanvasItem(item) &&
        locallyPersistedItemIds.has(item.id) &&
        hasLocallyPersistableCanvasSrc(item)
      ) {
        return { ...item, src: '' } as SerializableCanvasItem
      }
      return item
    })
    const payload: CanvasPersistedData = {
      items: persistedItems,
      groups,
      groupBranches,
      figmaBinding
    }
    store.put(payload, storeKey)

    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => {
        db.close()
        resolve()
      }
      tx.onerror = () => {
        db.close()
        rejectCanvasStorageError(reject, 'canvas metadata save transaction', tx.error)
      }
    })

    await saveProjectCanvasFile(
      storeKey,
      items,
      groups,
      groupBranches,
      figmaBinding,
      allBlobEntries
    )
  } catch (err) {
    console.error(
      '[Canvas Storage] 保存失败:',
      normalizeCanvasStorageError(err, '[Canvas Storage] Save failed.')
    )
  }
}

/**
 * Load canvas items from IndexedDB.
 * Image items still need their HTMLImageElement rebuilt later.
 * image / model3d / video / file items restore object URLs from the blob store.
 */
export async function loadCanvasItems(storeKey: string = KEY): Promise<{
  items: CanvasItem[]
  groups: CanvasGroup[]
  groupBranches: CanvasGroupBranch[]
  figmaBinding: CanvasFigmaBinding | null
}> {
  try {
    const db = await openDB()
    const tx = db.transaction(STORE_NAME, 'readonly')
    const store = tx.objectStore(STORE_NAME)
    const request = store.get(storeKey)

    const persisted = await new Promise<CanvasPersistedData | SerializableCanvasItem[] | undefined>(
      (resolve, reject) => {
        request.onsuccess = () =>
          resolve(request.result as CanvasPersistedData | SerializableCanvasItem[] | undefined)
        request.onerror = () =>
          rejectCanvasStorageError(reject, `canvas load request for ${storeKey}`, request.error)
      }
    )

    if (persisted === undefined) {
      db.close()
      const projectSnapshot = await loadCanvasItemsFromProjectFile(storeKey)
      return projectSnapshot ?? { items: [], groups: [], groupBranches: [], figmaBinding: null }
    }

    const {
      items: data,
      groups,
      groupBranches,
      figmaBinding
    } = extractPersistedCanvasData(persisted)
    const resolvedIndexedDbItems = await resolveIndexedDbProjectCanvasAssetUrls(storeKey, data)

    if (resolvedIndexedDbItems.length === 0) {
      db.close()
      const projectSnapshot = await loadCanvasItemsFromProjectFile(storeKey)
      return projectSnapshot ?? { items: [], groups, groupBranches, figmaBinding }
    }

    // Restore image / model3d / video / file blob URLs.
    const restorableBlobBackedItems = resolvedIndexedDbItems.filter(
      (item): item is SerializableBlobPersistableCanvasItem =>
        isBlobPersistableCanvasItem(item) && (!item.src || hasLocallyPersistableCanvasSrc(item))
    )
    const restoredItemBlobUrls = await loadBlobUrlMap(
      db,
      storeKey,
      restorableBlobBackedItems.map((item) => item.id)
    )
    const restoredTextureUrls = await loadBlobUrlMap(
      db,
      storeKey,
      restorableBlobBackedItems.flatMap((item) => {
        if (item.type !== 'model3d') return []
        const textures = (item as { textures?: Record<string, string> }).textures
        return textures
          ? Object.keys(textures).map((texName) => getModelTextureKey(item.id, texName))
          : []
      })
    )

    const restoredBlobUrls = new Map<string, string>([
      ...restoredItemBlobUrls,
      ...restoredTextureUrls
    ])
    const restoredItems = restorePersistedCanvasItems(resolvedIndexedDbItems, restoredBlobUrls)

    db.close()
    if (restoredItems.length === 0 && resolvedIndexedDbItems.length > 0) {
      const projectSnapshot = await loadCanvasItemsFromProjectFile(storeKey)
      return projectSnapshot ?? { items: [], groups, groupBranches, figmaBinding }
    }
    return { items: restoredItems, groups, groupBranches, figmaBinding }
  } catch (err) {
    console.error(
      '[Canvas Storage] 加载失败:',
      normalizeCanvasStorageError(err, '[Canvas Storage] Load failed.')
    )
    const projectSnapshot = await loadCanvasItemsFromProjectFile(storeKey)
    return projectSnapshot ?? { items: [], groups: [], groupBranches: [], figmaBinding: null }
  }
}

/**
 * Clear canvas data in IndexedDB, including blob payloads.
 */
export async function clearCanvasItems(storeKey: string = KEY): Promise<void> {
  try {
    const db = await openDB()

    // Clear canvas metadata.
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    store.delete(storeKey)

    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve()
      tx.onerror = () =>
        rejectCanvasStorageError(reject, 'canvas metadata clear transaction', tx.error)
    })

    try {
      const scopedBlobKeys = await new Promise<string[]>((resolve, reject) => {
        const blobTx = db.transaction(BLOB_STORE_NAME, 'readonly')
        const blobStore = blobTx.objectStore(BLOB_STORE_NAME)
        const req = blobStore.getAllKeys()
        req.onsuccess = () =>
          resolve(
            req.result
              .map((key) => String(key))
              .filter((key) => getLogicalCanvasBlobKey(storeKey, key) !== null)
          )
        req.onerror = () =>
          rejectCanvasStorageError(reject, 'blob key enumeration request', req.error)
      })

      for (const key of scopedBlobKeys) {
        await deleteBlobData(db, key)
      }
    } catch {
      // getAllKeys may not be available in very old environments; keep metadata clearing intact.
    }
    db.close()

    await saveProjectCanvasFile(storeKey, [], [], [], null)
  } catch (err) {
    console.error(
      '[Canvas Storage] 清空失败:',
      normalizeCanvasStorageError(err, '[Canvas Storage] Clear failed.')
    )
  }
}

// Canvas file export/import helpers.
const CANVAS_FILE_MAGIC = 'MAGICPOT_CANVAS'
export const CANVAS_FILE_VERSION = 8 // v8: default exports omit quick-app state.
export const CANVAS_FILE_EXT = '.mpcanvas'

/** Embedded blob payload entry. */
interface EmbeddedBlob {
  /** Base64-encoded binary data. */
  base64: string
  /** MIME type. */
  mimeType: string
}

interface CanvasFileData {
  magic: typeof CANVAS_FILE_MAGIC
  version: number
  createdAt: string
  storageMode?: CanvasFileStorageMode
  items: SerializableCanvasItem[]
  groups?: CanvasGroup[]
  groupBranches?: CanvasGroupBranch[]
  figmaBinding?: CanvasFigmaBinding | null
  // Legacy qapp state from older .mpcanvas exports. Default exports no longer include it.
  currentQAppKey?: string
  qAppCache?: Record<string, unknown>
  // v2: Embedded blob payloads keyed by item.id.
  blobs?: Record<string, EmbeddedBlob>
}

type RestoredCanvasFileSnapshot = CanvasSnapshot & {
  qAppKey?: string
}

// Base64 helpers.

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes.buffer
}

function resolveCanvasAssetFileName(
  item: BlobPersistableCanvasItem | SerializableBlobPersistableCanvasItem
): string {
  const explicitName = item.fileName?.trim()
  if (explicitName) {
    return explicitName
  }

  if (item.src) {
    const fallback = `${item.type}-${item.id}`
    return getDownloadFileNameFromUrl(item.src, fallback)
  }

  const fallbackExtension =
    item.type === 'image'
      ? '.png'
      : item.type === 'video'
        ? '.mp4'
        : item.type === 'model3d'
          ? '.glb'
          : '.bin'
  return `${item.type}-${item.id}${fallbackExtension}`
}

async function collectCanvasEmbeddedAssets(
  items: CanvasItem[],
  excludeKeys: ReadonlySet<string> = new Set(),
  storeKey?: string
): Promise<ResolvedCanvasBinaryAsset[]> {
  const tasks: Array<Promise<ResolvedCanvasBinaryAsset | null>> = []

  for (const item of items) {
    if (!isBlobPersistableCanvasItem(item) || !item.src) {
      continue
    }

    const resolvedFileName = resolveCanvasAssetFileName(item)
    if (!excludeKeys.has(item.id)) {
      tasks.push(
        resolveCanvasBinaryAssetForItem(
          item,
          item.id,
          item.src,
          resolvedFileName,
          guessMimeType(resolvedFileName),
          storeKey,
          { allowIndexedDbFallback: true }
        )
      )
    }

    if (item.type === 'model3d' && item.textures) {
      for (const [textureName, textureUrl] of Object.entries(item.textures)) {
        const textureKey = getModelTextureKey(item.id, textureName)
        if (excludeKeys.has(textureKey)) {
          continue
        }

        tasks.push(
          resolveCanvasBinaryAsset(
            textureKey,
            textureUrl,
            textureName,
            guessTextureMimeType(textureName),
            storeKey,
            { allowIndexedDbFallback: true }
          )
        )
      }
    }
  }

  return (await Promise.all(tasks)).filter((entry): entry is ResolvedCanvasBinaryAsset => !!entry)
}

function buildCanvasAssetFileNameMap(items: CanvasItem[]): Map<string, string> {
  const assetFileNames = new Map<string, string>()

  for (const item of items) {
    if (!isBlobPersistableCanvasItem(item) || !item.src) {
      continue
    }

    assetFileNames.set(item.id, resolveCanvasAssetFileName(item))

    if (item.type === 'model3d' && item.textures) {
      for (const textureName of Object.keys(item.textures)) {
        assetFileNames.set(getModelTextureKey(item.id, textureName), textureName)
      }
    }
  }

  return assetFileNames
}

function getCanvasSavePathCacheKey(canvasId?: string): string | null {
  return canvasId ? `canvas.savePath.${canvasId}` : null
}

export function getCanvasSaveTargetPath(canvasId?: string): string | null {
  const cacheKey = getCanvasSavePathCacheKey(canvasId)
  if (!cacheKey) {
    return null
  }

  try {
    const cachedPath = localStorage.getItem(cacheKey)?.trim()
    return cachedPath || null
  } catch {
    return null
  }
}

export function rememberCanvasSaveTargetPath(
  canvasId: string | undefined,
  targetPath: string
): void {
  const cacheKey = getCanvasSavePathCacheKey(canvasId)
  if (!cacheKey) {
    return
  }

  try {
    localStorage.setItem(cacheKey, targetPath)
  } catch {
    // Ignore localStorage write failures.
  }
}

export function clearCanvasSaveTargetPath(canvasId?: string): void {
  const cacheKey = getCanvasSavePathCacheKey(canvasId)
  if (!cacheKey) {
    return
  }

  try {
    localStorage.removeItem(cacheKey)
  } catch {
    // Ignore localStorage write failures.
  }
}

async function writeCanvasExportToPath(targetPath: string, json: string): Promise<void> {
  if (!window.api?.svcFs || !window.path) {
    throw new Error('Native canvas save is unavailable.')
  }

  const buffer = new TextEncoder().encode(json)
  const dirPath = window.path.dirname(targetPath)
  const outFilename = window.path.basename(targetPath)

  await window.api.svcFs.saveImageToPath({
    image: buffer,
    outputPath: dirPath,
    filename: outFilename
  })
}

async function buildCanvasFileData(
  items: CanvasItem[],
  groups: CanvasGroup[] = [],
  groupBranches: CanvasGroupBranch[] = [],
  figmaBinding: CanvasFigmaBinding | null = null,
  seededAssetEntries: readonly BlobWriteEntry[] = [],
  storeKey?: string
): Promise<{
  canvasFileData: CanvasFileData
  assetEntries: ResolvedCanvasBinaryAsset[]
}> {
  const serialized = serializeItems(items)
  const assetFileNames = buildCanvasAssetFileNameMap(items)
  const seededAssets = Array.from(
    new Map(
      seededAssetEntries.map((entry) => [
        entry.key,
        {
          ...entry,
          fileName: assetFileNames.get(entry.key) || entry.key
        } satisfies ResolvedCanvasBinaryAsset
      ])
    ).values()
  )
  const collectedAssets = await collectCanvasEmbeddedAssets(
    items,
    new Set(seededAssets.map((entry) => entry.key)),
    storeKey
  )
  const assetEntries = [...seededAssets, ...collectedAssets]
  const blobs =
    assetEntries.length > 0
      ? Object.fromEntries(
          assetEntries.map((entry) => [
            entry.key,
            {
              base64: arrayBufferToBase64(entry.data),
              mimeType: entry.mimeType
            } satisfies EmbeddedBlob
          ])
        )
      : undefined

  return {
    canvasFileData: {
      magic: CANVAS_FILE_MAGIC,
      version: CANVAS_FILE_VERSION,
      createdAt: new Date().toISOString(),
      storageMode: 'embedded',
      items: serialized,
      groups,
      groupBranches,
      figmaBinding,
      blobs
    },
    assetEntries
  }
}

async function buildProjectCanvasFileData(
  items: CanvasItem[],
  projectRootDir: string,
  groups: CanvasGroup[] = [],
  groupBranches: CanvasGroupBranch[] = [],
  figmaBinding: CanvasFigmaBinding | null = null,
  seededAssetEntries: readonly BlobWriteEntry[] = [],
  storeKey?: string
): Promise<{
  canvasFileData: CanvasFileData
  assetEntries: ResolvedCanvasBinaryAsset[]
}> {
  const serializedItems = serializeItems(items)
  const assetFileNames = buildCanvasAssetFileNameMap(items)
  const projectAssetRefs = buildProjectAssetRefMap(items)
  const seededAssets = new Map(
    seededAssetEntries.map((entry) => [
      entry.key,
      {
        ...entry,
        fileName: assetFileNames.get(entry.key) || entry.key,
        projectAssetRef: projectAssetRefs.get(entry.key)
      } satisfies ResolvedCanvasBinaryAsset
    ])
  )
  const assetEntries = new Map<string, ResolvedCanvasBinaryAsset>()
  const projectItems = await Promise.all(
    serializedItems.map(async (serializedItem, index) => {
      const sourceItem = items[index]
      if (
        !isBlobPersistableCanvasItem(serializedItem) ||
        !isBlobPersistableCanvasItem(sourceItem) ||
        !serializedItem.src ||
        !sourceItem.src
      ) {
        return serializedItem
      }

      const nextItem = { ...serializedItem } as SerializableBlobPersistableCanvasItem
      const resolvedFileName =
        assetFileNames.get(sourceItem.id) || resolveCanvasAssetFileName(sourceItem)
      const projectCrop =
        serializedItem.type === 'image' && sourceItem.type === 'image'
          ? normalizeProjectCanvasImageCrop(sourceItem)
          : null
      const croppedImageMimeType =
        serializedItem.type === 'image' && sourceItem.type === 'image' && projectCrop
          ? resolveProjectCroppedImageMimeType(sourceItem, resolvedFileName)
          : null

      if (
        serializedItem.type === 'image' &&
        sourceItem.type === 'image' &&
        projectCrop &&
        croppedImageMimeType
      ) {
        const croppedFileName = ensureProjectImageFileNameMatchesMimeType(
          resolvedFileName,
          croppedImageMimeType
        )
        const croppedAssetRef = buildProjectAssetRef(
          sourceItem.id,
          croppedFileName,
          sourceItem.type
        )
        const sourceAsset =
          seededAssets.get(sourceItem.id) ||
          (await resolveCanvasBinaryAssetForItem(
            sourceItem,
            sourceItem.id,
            sourceItem.src,
            croppedFileName,
            guessMimeType(croppedFileName),
            storeKey,
            { allowIndexedDbFallback: true }
          ))

        if (sourceAsset) {
          const croppedAsset = await createProjectCroppedImageAsset(
            sourceAsset,
            projectCrop,
            croppedImageMimeType,
            croppedFileName
          )
          if (croppedAsset) {
            assetEntries.set(croppedAsset.key, {
              ...croppedAsset,
              projectAssetRef: croppedAssetRef
            })
            const flattenedImageItem = {
              ...(nextItem as SerializableCanvasItem & { crop?: CanvasImageItem['crop'] })
            }
            delete flattenedImageItem.crop

            return {
              ...flattenedImageItem,
              src: croppedAssetRef,
              sourceWidth: croppedAsset.pixelWidth,
              sourceHeight: croppedAsset.pixelHeight,
              sizeBytes: croppedAsset.data.byteLength
            } as SerializableCanvasItem
          }
        } else {
          console.error(
            '[Canvas Storage] Failed to resolve cropped image source asset:',
            sourceItem.id
          )
        }
      }

      const assetRef =
        projectAssetRefs.get(sourceItem.id) ||
        buildProjectAssetRef(sourceItem.id, resolvedFileName, sourceItem.type)
      const assetFullPath = resolveProjectAssetFullPath(projectRootDir, assetRef)

      if (assetFullPath) {
        let canReferenceProjectAsset = sourceAlreadyMatchesProjectAsset(
          sourceItem.src,
          assetFullPath
        )
        if (!canReferenceProjectAsset) {
          const resolvedAsset =
            seededAssets.get(sourceItem.id) ||
            (await resolveCanvasBinaryAssetForItem(
              sourceItem,
              sourceItem.id,
              sourceItem.src,
              resolvedFileName,
              guessMimeType(resolvedFileName),
              storeKey,
              { allowIndexedDbFallback: true }
            ))

          if (resolvedAsset) {
            assetEntries.set(resolvedAsset.key, {
              ...resolvedAsset,
              projectAssetRef: assetRef
            })
            canReferenceProjectAsset = true
          } else {
            console.error('[Canvas Storage] Failed to stage project asset:', sourceItem.id)
          }
        }

        if (canReferenceProjectAsset) {
          nextItem.src = assetRef
        }
      }

      if (
        serializedItem.type === 'model3d' &&
        sourceItem.type === 'model3d' &&
        sourceItem.textures
      ) {
        const nextTextures: Record<string, string> = {}
        for (const [textureName, textureUrl] of Object.entries(sourceItem.textures)) {
          const textureKey = getModelTextureKey(sourceItem.id, textureName)
          const textureRef =
            projectAssetRefs.get(textureKey) ||
            buildProjectAssetRef(textureKey, textureName, 'texture')
          const textureFullPath = resolveProjectAssetFullPath(projectRootDir, textureRef)

          if (!textureFullPath) {
            nextTextures[textureName] = textureUrl
            continue
          }

          let canReferenceProjectTexture = sourceAlreadyMatchesProjectAsset(
            textureUrl,
            textureFullPath
          )
          if (!canReferenceProjectTexture) {
            const resolvedTextureAsset =
              seededAssets.get(textureKey) ||
              (await resolveCanvasBinaryAsset(
                textureKey,
                textureUrl,
                textureName,
                guessTextureMimeType(textureName),
                storeKey,
                { allowIndexedDbFallback: true }
              ))

            if (resolvedTextureAsset) {
              assetEntries.set(resolvedTextureAsset.key, {
                ...resolvedTextureAsset,
                projectAssetRef: textureRef
              })
              canReferenceProjectTexture = true
            } else {
              console.error('[Canvas Storage] Failed to stage project texture asset:', textureKey)
            }
          }

          nextTextures[textureName] = canReferenceProjectTexture ? textureRef : textureUrl
        }

        nextItem.textures = nextTextures
      }

      return nextItem as SerializableCanvasItem
    })
  )

  return {
    canvasFileData: {
      magic: CANVAS_FILE_MAGIC,
      version: CANVAS_FILE_VERSION,
      createdAt: new Date().toISOString(),
      storageMode: 'project',
      items: projectItems,
      groups,
      groupBranches,
      figmaBinding
    },
    assetEntries: [...assetEntries.values()]
  }
}

function resolveCanvasFileStorageMode(data: CanvasFileData): CanvasFileStorageMode {
  return data.storageMode === 'project' ? 'project' : 'embedded'
}

function resolveProjectCanvasAssetUrls(
  items: readonly SerializableCanvasItem[],
  canvasBaseDir: string | undefined,
  storageMode: CanvasFileStorageMode
): SerializableCanvasItem[] {
  if (!canvasBaseDir || storageMode !== 'project') {
    return [...items]
  }

  return items.map((item) => {
    if (!isBlobPersistableCanvasItem(item)) {
      return item
    }

    let nextItem: SerializableBlobPersistableCanvasItem = item
    if (item.src && isRelativeCanvasAssetReference(item.src)) {
      const fullPath = resolveProjectAssetFullPath(canvasBaseDir, item.src)
      if (fullPath) {
        nextItem = { ...nextItem, src: toLocalMediaUrl(fullPath) }
      }
    }

    if (item.type === 'model3d' && item.textures) {
      const nextTextures = Object.fromEntries(
        Object.entries(item.textures).map(([textureName, textureSource]) => {
          if (!isRelativeCanvasAssetReference(textureSource)) {
            return [textureName, textureSource]
          }

          const fullPath = resolveProjectAssetFullPath(canvasBaseDir, textureSource)
          return [textureName, fullPath ? toLocalMediaUrl(fullPath) : textureSource]
        })
      )
      nextItem = { ...nextItem, textures: nextTextures }
    }

    return nextItem as SerializableCanvasItem
  })
}

function hasRelativeProjectCanvasAssetRefs(items: readonly SerializableCanvasItem[]): boolean {
  return items.some((item) => {
    if (!isBlobPersistableCanvasItem(item)) {
      return false
    }

    if (item.src && isRelativeCanvasAssetReference(item.src)) {
      return true
    }

    return Boolean(
      item.type === 'model3d' &&
      item.textures &&
      Object.values(item.textures).some((textureSource) =>
        isRelativeCanvasAssetReference(textureSource)
      )
    )
  })
}

async function resolveIndexedDbProjectCanvasAssetUrls(
  storeKey: string,
  items: readonly SerializableCanvasItem[]
): Promise<SerializableCanvasItem[]> {
  if (!hasRelativeProjectCanvasAssetRefs(items)) {
    return [...items]
  }

  const location = await getProjectCanvasLocation(storeKey)
  return resolveProjectCanvasAssetUrls(items, location?.projectRootDir, 'project')
}

async function validateProjectCanvasAssetRefs(
  items: readonly SerializableCanvasItem[],
  canvasBaseDir: string | undefined,
  storageMode: CanvasFileStorageMode
): Promise<void> {
  if (
    !canvasBaseDir ||
    storageMode !== 'project' ||
    !window.api?.svcFs ||
    typeof window.api.svcFs.listFilesInFolder !== 'function'
  ) {
    return
  }

  const expectedAssetPaths = new Set<string>()
  for (const item of items) {
    if (!isBlobPersistableCanvasItem(item)) {
      continue
    }

    if (item.src && isRelativeCanvasAssetReference(item.src)) {
      const fullPath = resolveProjectAssetFullPath(canvasBaseDir, item.src)
      if (fullPath) {
        expectedAssetPaths.add(normalizeComparablePath(fullPath))
      }
    }

    if (item.type === 'model3d' && item.textures) {
      for (const textureSource of Object.values(item.textures)) {
        if (!isRelativeCanvasAssetReference(textureSource)) {
          continue
        }

        const fullPath = resolveProjectAssetFullPath(canvasBaseDir, textureSource)
        if (fullPath) {
          expectedAssetPaths.add(normalizeComparablePath(fullPath))
        }
      }
    }
  }

  if (expectedAssetPaths.size === 0) {
    return
  }

  const { files } = await window.api.svcFs.listFilesInFolder({
    folderPath: canvasBaseDir,
    recursive: true
  })
  const existingFiles = new Set(files.map((file) => normalizeComparablePath(file.fullPath)))

  for (const expectedPath of expectedAssetPaths) {
    if (!existingFiles.has(expectedPath)) {
      console.error('[Canvas Storage] Project asset missing:', expectedPath)
    }
  }
}

async function persistCanvasFileEmbeddedAssets(
  blobs: Record<string, EmbeddedBlob> | undefined
): Promise<void> {
  if (!blobs || Object.keys(blobs).length === 0) {
    return
  }

  try {
    const db = await openDB()
    const entries = Object.entries(blobs).map(([key, embedded]) => ({
      key,
      data: base64ToArrayBuffer(embedded.base64),
      mimeType: embedded.mimeType
    }))
    await saveBlobEntries(db, KEY, entries)
    db.close()
    console.log(`[Canvas Import] Persisted ${entries.length} embedded assets to IndexedDB`)
  } catch (error) {
    console.warn('[Canvas Import] Failed to persist embedded assets', error)
  }
}

async function restoreCanvasFileData(
  data: CanvasFileData,
  options: CanvasFileRestoreOptions = {}
): Promise<RestoredCanvasFileSnapshot> {
  if (data.magic !== CANVAS_FILE_MAGIC) {
    throw new Error('Invalid MagicPot canvas file')
  }

  const {
    restoreQAppState = true,
    persistEmbeddedAssetsToIndexedDb = true,
    canvasBaseDir
  } = options
  const storageMode = resolveCanvasFileStorageMode(data)

  if (restoreQAppState) {
    if (data.qAppCache) {
      restoreGlobalQAppCache(data.qAppCache)
    }
    if (data.currentQAppKey) {
      localStorage.setItem('qapp.currentQAppKey', data.currentQAppKey)
      window.dispatchEvent(
        new CustomEvent('qapp:switch', {
          detail: { qAppKey: data.currentQAppKey }
        })
      )
    }
  }

  const restoredBlobUrls = new Map(
    Object.entries(data.blobs || {}).map(([blobKey, embedded]) => {
      const buffer = base64ToArrayBuffer(embedded.base64)
      const blob = new Blob([buffer], { type: embedded.mimeType })
      return [blobKey, URL.createObjectURL(blob)] as const
    })
  )

  if (persistEmbeddedAssetsToIndexedDb) {
    await persistCanvasFileEmbeddedAssets(data.blobs)
  }

  if (storageMode === 'project' && !canvasBaseDir) {
    console.error('[Canvas Import] Project canvas file is missing its base directory context.')
  }

  await validateProjectCanvasAssetRefs(data.items, canvasBaseDir, storageMode)
  const resolvedItems = resolveProjectCanvasAssetUrls(data.items, canvasBaseDir, storageMode)
  const restoredItems = restorePersistedCanvasItems(resolvedItems, restoredBlobUrls)
  const blobCount = data.blobs ? Object.keys(data.blobs).length : 0
  console.log(
    `[Canvas Import] Version ${data.version}, mode ${storageMode}, created at ${data.createdAt}, restored ${data.items.length} items` +
      (blobCount > 0 ? ` (${blobCount} embedded assets)` : '')
  )

  return {
    items: restoredItems as CanvasItem[],
    groups: data.groups || [],
    groupBranches: data.groupBranches || [],
    qAppKey: restoreQAppState ? data.currentQAppKey : undefined,
    figmaBinding: data.figmaBinding || null
  }
}

/**
 * Export canvas items to an .mpcanvas file.
 * v6 embeds all canvas binary assets so exports stay restorable on a fresh device.
 */
export async function exportCanvasFile(
  items: CanvasItem[],
  fileName?: string,
  canvasId?: string,
  forceSaveAs: boolean = false,
  groups: CanvasGroup[] = [],
  figmaBinding: CanvasFigmaBinding | null = null,
  groupBranches: CanvasGroupBranch[] = [],
  updateCurrentDocumentPath: boolean = true
): Promise<void> {
  const name =
    fileName ||
    `canvas_${new Date().toLocaleDateString('zh-CN').replace(/\//g, '-')}${CANVAS_FILE_EXT}`

  const { canvasFileData } = await buildCanvasFileData(
    items,
    groups,
    groupBranches,
    figmaBinding,
    [],
    canvasId
  )
  const json = JSON.stringify(canvasFileData)
  const blobCount = Object.keys(canvasFileData.blobs || {}).length
  const cachedTargetPath = getCanvasSaveTargetPath(canvasId)

  if (!forceSaveAs && cachedTargetPath && window.api?.svcFs && window.path) {
    try {
      await writeCanvasExportToPath(cachedTargetPath, json)
      console.log(
        `[Canvas Export] Saved ${items.length} items to ${cachedTargetPath}` +
          (blobCount > 0 ? ` (${blobCount} embedded assets)` : '')
      )
      return
    } catch (err) {
      clearCanvasSaveTargetPath(canvasId)
      console.error('[Canvas Export] Cached save target failed, reopening Save As flow', err)
    }
  }

  // Try the native Electron save flow first.
  if (window.api && window.api.svcDialog && window.api.svcFs && window.path) {
    let targetPath: string | null = null

    if (!targetPath) {
      const projectCanvasLocation = canvasId ? await getProjectCanvasLocation(canvasId) : null
      const res = await window.api.svcDialog.showSaveDialog({
        title: forceSaveAs ? 'Save Canvas As' : 'Save Canvas',
        defaultPath: cachedTargetPath || projectCanvasLocation?.canvasFullPath || name,
        filters: [{ name: 'MPCANVAS File', extensions: ['mpcanvas'] }]
      })
      if (res.canceled || !res.filePath) {
        return // User canceled.
      }
      targetPath = res.filePath
      if (updateCurrentDocumentPath) {
        rememberCanvasSaveTargetPath(canvasId, targetPath)
      }
    }

    try {
      await writeCanvasExportToPath(targetPath, json)
      console.log(
        `[Canvas Export] Saved ${items.length} items to ${targetPath}` +
          (blobCount > 0 ? ` (${blobCount} embedded assets)` : '')
      )
      // saveImageToPath handles arbitrary binary payloads, so no extra extension fixup is needed.
      return
    } catch (err) {
      console.error('[Canvas Export] Native save failed, falling back to browser download', err)
    }
  }

  // Fall back to a browser download when native save is unavailable.
  const blob = new Blob([json], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)

  console.log(
    `[Canvas Export] Exported ${items.length} items to ${name}` +
      (blobCount > 0 ? ` (${blobCount} embedded assets)` : '')
  )
}

/**
 * Import canvas items from an .mpcanvas file.
 * v2 restores embedded blob payloads back into object URLs.
 * Default imports restore canvas data only; legacy qapp state is ignored.
 * Placement metadata is preserved exactly as exported.
 */
export async function exportCanvasFileAsStandalone(
  items: CanvasItem[],
  fileName?: string,
  canvasId?: string,
  groups: CanvasGroup[] = [],
  figmaBinding: CanvasFigmaBinding | null = null,
  groupBranches: CanvasGroupBranch[] = []
): Promise<void> {
  await exportCanvasFile(
    items,
    fileName,
    canvasId,
    true,
    groups,
    figmaBinding,
    groupBranches,
    false
  )
}

export async function importCanvasFile(file: File): Promise<{
  items: CanvasItem[]
  groups: CanvasGroup[]
  groupBranches: CanvasGroupBranch[]
  qAppKey?: string
  figmaBinding: CanvasFigmaBinding | null
}> {
  const text = await file.text()
  const data = JSON.parse(text) as CanvasFileData
  const canvasFilePath = (file as File & { path?: string }).path
  const canvasBaseDir =
    canvasFilePath && window.path && typeof window.path.dirname === 'function'
      ? window.path.dirname(canvasFilePath)
      : undefined
  return await restoreCanvasFileData(data, {
    restoreQAppState: false,
    persistEmbeddedAssetsToIndexedDb: true,
    canvasBaseDir
  })
}

/**
 * Detect whether a file is an .mpcanvas export.
 */
export function isCanvasFile(fileName: string): boolean {
  return fileName.toLowerCase().endsWith(CANVAS_FILE_EXT)
}
