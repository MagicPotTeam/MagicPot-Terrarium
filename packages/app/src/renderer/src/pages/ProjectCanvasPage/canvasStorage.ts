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
import { getElectronCanvasFilePath } from './canvasLocalFileSource'
import { assertCanvasImportFileSize, parseCanvasImportText } from './canvasImportPreflight'

const DB_NAME = 'magicpot-canvas'
const DB_VERSION = 2 // bumped for new blob store
const STORE_NAME = 'canvas-items'
const BLOB_STORE_NAME = 'canvas-blobs' // Stores binary payloads such as 3D models and videos.
const BLOB_STORE_KEY_SEPARATOR = '::canvas::'
const KEY = 'default' // Single-canvas scene; use a fixed key.
const PROJECT_CANVAS_FILENAME = 'project.mpcanvas'
const AUTOSAVE_CANVAS_FILENAME = PROJECT_CANVAS_FILENAME
const AUTOSAVE_PROJECT_LIMIT = 8
const PROJECT_ASSET_DIRNAME = 'assets'

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
      const { image, sourceFile, thumbnailSet: _thumbnailSet, sourceIdentity, ...rest } = item
      const persistedSourceIdentity =
        sourceIdentity?.kind === 'local-file' ? sourceIdentity : undefined
      // Source-size hints may come from stale thumbnail or display metadata.
      // Without pixel provenance, even a geometrical identity can be a crop.
      // Persist it verbatim; source and crop remain separate in project mirrors.
      return {
        ...rest,
        ...(persistedSourceIdentity ? { sourceIdentity: persistedSourceIdentity } : {})
      } as SerializableCanvasItem
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

type CanvasFileStorageMode = 'embedded' | 'project'

type CanvasFileRestoreOptions = {
  restoreQAppState?: boolean
  persistEmbeddedAssetsToIndexedDb?: boolean
  requireNewEmbeddedAssets?: boolean
  canvasBaseDir?: string
  storeKey?: string
  isCurrent?: () => boolean
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

async function resolveAutoSaveRootPath(): Promise<string | null> {
  if (!window.api?.svcState) return null
  try {
    const response = await window.api.svcState.getUserDataDirectoryState({})
    return response.state?.autoSaveRoot || null
  } catch (error) {
    console.warn('[Canvas Storage] Failed to resolve autosave root:', error)
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
  itemType: BlobPersistableCanvasItem['type'] | 'texture',
  snapshotId: string
): string {
  return `${PROJECT_ASSET_DIRNAME}/${snapshotId}/${resolveProjectAssetCategory(itemType)}/${buildProjectAssetFileName(assetKey, rawFileName)}`
}

function buildProjectAssetRefMap(items: CanvasItem[], snapshotId: string): Map<string, string> {
  const refs = new Map<string, string>()

  for (const item of items) {
    if (!isBlobPersistableCanvasItem(item) || !item.src) {
      continue
    }

    const resolvedFileName = resolveCanvasAssetFileName(item)
    refs.set(item.id, buildProjectAssetRef(item.id, resolvedFileName, item.type, snapshotId))

    if (item.type === 'model3d' && item.textures) {
      for (const textureName of Object.keys(item.textures)) {
        const textureKey = getModelTextureKey(item.id, textureName)
        refs.set(textureKey, buildProjectAssetRef(textureKey, textureName, 'texture', snapshotId))
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
    assetEntries.map(async (entry) => {
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

      const receipt = await window.api.svcFs.saveImageToPath({
        image: new Uint8Array(entry.data),
        outputPath,
        filename
      })
      if (receipt?.success !== true) {
        throw new Error('CANVAS_PROJECT_ASSET_WRITE_UNACKNOWLEDGED')
      }
    })
  )
}

async function saveAutoSaveCanvasFile(
  storeKey: string,
  items: CanvasItem[],
  groups: CanvasGroup[],
  groupBranches: CanvasGroupBranch[],
  figmaBinding: CanvasFigmaBinding | null,
  blobEntries: readonly ResolvedCanvasBinaryAsset[]
): Promise<boolean> {
  if (!window.api?.svcFs || !window.path) return false
  const autoSaveRoot = await resolveAutoSaveRootPath()
  if (!autoSaveRoot) return false
  const projectDir = window.path.join(autoSaveRoot, resolveProjectStorageDirName(storeKey))
  const assetDir = window.path.join(projectDir, PROJECT_ASSET_DIRNAME)
  try {
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0))
    const { canvasFileData, assetEntries } = await buildProjectCanvasFileData(
      items,
      projectDir,
      groups,
      groupBranches,
      figmaBinding,
      blobEntries,
      storeKey
    )
    await writeProjectAssetFiles(assetDir, assetEntries)
    const receipt = await window.api.svcFs.writeTextFile({
      outputPath: projectDir,
      filename: AUTOSAVE_CANVAS_FILENAME,
      content: JSON.stringify(canvasFileData)
    })
    if (receipt?.success !== true) {
      throw new Error('CANVAS_PROJECT_METADATA_WRITE_UNACKNOWLEDGED')
    }
    if (typeof window.api.svcFs.pruneAutoSaveProjects === 'function') {
      void window.api.svcFs.pruneAutoSaveProjects({
        currentProjectDirName: resolveProjectStorageDirName(storeKey),
        maxProjects: AUTOSAVE_PROJECT_LIMIT
      })
    }
    return true
  } catch (error) {
    console.warn('[Canvas Storage] Failed to write autosave:', error)
    return false
  }
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
    const receipt = await window.api.svcFs.writeTextFile({
      outputPath: location.projectRootDir,
      filename: location.canvasFilename,
      content: JSON.stringify(canvasFileData)
    })
    if (receipt?.success !== true) {
      throw new Error('CANVAS_PROJECT_METADATA_WRITE_UNACKNOWLEDGED')
    }
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
      // A fallback is a read, not an IDB commit: writing its embedded bytes
      // independently can overwrite a live canvas (or mix two snapshots).
      // Restored object URLs remain usable until the ordinary explicit save.
      persistEmbeddedAssetsToIndexedDb: false,
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

type CanvasStoredBinary = { data: ArrayBuffer; mimeType: string }

// Enqueue these reads while the metadata request's transaction is active.
// Blob URLs are created only after the combined readonly transaction commits.
function queueCanvasBlobSnapshotReads(
  store: IDBObjectStore,
  storeKey: string,
  itemIds: readonly string[],
  target: Map<string, CanvasStoredBinary>
): void {
  for (const itemId of new Set(itemIds)) {
    const scopedRequest = store.get(getScopedCanvasBlobKey(storeKey, itemId))
    const legacyRequest = store.get(itemId)
    let scopedResult: CanvasStoredBinary | undefined
    let legacyResult: CanvasStoredBinary | undefined
    let completed = 0
    const finish = () => {
      if (++completed !== 2) return
      const result = scopedResult || legacyResult
      if (result) target.set(itemId, result)
    }
    scopedRequest.onsuccess = () => {
      scopedResult = scopedRequest.result as CanvasStoredBinary | undefined
      finish()
    }
    legacyRequest.onsuccess = () => {
      legacyResult = legacyRequest.result as CanvasStoredBinary | undefined
      finish()
    }
    // Request errors abort the transaction; do not prevent their default action.
  }
}

async function readIndexedDbCanvasSnapshot(
  db: IDBDatabase,
  storeKey: string
): Promise<{
  persisted: CanvasPersistedData | SerializableCanvasItem[] | undefined
  binaries: Map<string, CanvasStoredBinary>
}> {
  return await new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_NAME, BLOB_STORE_NAME], 'readonly')
    const binaries = new Map<string, CanvasStoredBinary>()
    let persisted: CanvasPersistedData | SerializableCanvasItem[] | undefined
    tx.oncomplete = () => resolve({ persisted, binaries })
    tx.onabort = () => rejectCanvasStorageError(reject, 'canvas snapshot read transaction', tx.error)
    tx.onerror = () => rejectCanvasStorageError(reject, 'canvas snapshot read transaction', tx.error)
    try {
      const request = tx.objectStore(STORE_NAME).get(storeKey)
      request.onsuccess = () => {
        try {
          persisted = request.result as CanvasPersistedData | SerializableCanvasItem[] | undefined
          if (persisted === undefined) return
          const { items } = extractPersistedCanvasData(persisted)
          const blobBackedItems = items.filter(
            (item): item is SerializableBlobPersistableCanvasItem =>
              isBlobPersistableCanvasItem(item) &&
              (!item.src || hasLocallyPersistableCanvasSrc(item) || isRelativeCanvasAssetReference(item.src))
          )
          const keys = blobBackedItems.flatMap((item) => [
            item.id,
            ...(item.type === 'model3d' && item.textures
              ? Object.keys(item.textures).map((name) => getModelTextureKey(item.id, name))
              : [])
          ])
          queueCanvasBlobSnapshotReads(tx.objectStore(BLOB_STORE_NAME), storeKey, keys, binaries)
        } catch (error) {
          try { tx.abort() } catch { /* Already inactive. */ }
          rejectCanvasStorageError(reject, 'canvas snapshot read transaction', error)
        }
      }
    } catch (error) {
      try { tx.abort() } catch { /* Already inactive. */ }
      rejectCanvasStorageError(reject, 'canvas snapshot read transaction', error)
    }
  })
}

function createCanvasBlobUrlMap(
  binaries: ReadonlyMap<string, CanvasStoredBinary>
): Map<string, string> {
  const urls = new Map<string, string>()
  try {
    for (const [key, value] of binaries) {
      urls.set(key, URL.createObjectURL(new Blob([value.data], { type: value.mimeType })))
    }
    return urls
  } catch (error) {
    for (const url of urls.values()) URL.revokeObjectURL(url)
    throw error
  }
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

async function loadCanvasItemsFromAutoSaveFile(storeKey: string): Promise<CanvasSnapshot | null> {
  if (!window.path) return null
  const autoSaveRoot = await resolveAutoSaveRootPath()
  if (!autoSaveRoot) return null
  const projectDir = window.path.join(autoSaveRoot, resolveProjectStorageDirName(storeKey))
  return readCanvasItemsFromProjectFile(window.path.join(projectDir, AUTOSAVE_CANVAS_FILENAME))
}

async function loadCanvasFallback(storeKey: string): Promise<CanvasSnapshot | null> {
  return (
    (await loadCanvasItemsFromAutoSaveFile(storeKey)) || loadCanvasItemsFromProjectFile(storeKey)
  )
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
  let db: IDBDatabase | undefined
  try {
    db = await openDB()

    // 1. Persist blob-backed binary data (image / model3d / video / file).
    const blobItems = items.filter(
      (item): item is BlobPersistableCanvasItem =>
        isBlobPersistableCanvasItem(item) &&
        hasLocallyPersistableCanvasSrc(item) &&
        !(item.type === 'image' && item.media?.kind === 'managed')
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
    // Commit binary entries and metadata together so an aborted write cannot
    // pair old metadata with newly overwritten bytes.
    const tx = db.transaction([BLOB_STORE_NAME, STORE_NAME], 'readwrite')
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve()
      tx.onabort = () => {
        rejectCanvasStorageError(reject, 'canvas snapshot save transaction', tx.error)
      }
      tx.onerror = () => {
        rejectCanvasStorageError(reject, 'canvas snapshot save transaction', tx.error)
      }
      try {
        const blobStore = tx.objectStore(BLOB_STORE_NAME)
        for (const entry of allBlobEntries) {
          blobStore.put(
            { data: entry.data, mimeType: entry.mimeType },
            getScopedCanvasBlobKey(storeKey, entry.key)
          )
        }
        tx.objectStore(STORE_NAME).put(payload, storeKey)
      } catch (error) {
        try { tx.abort() } catch { /* Already inactive. */ }
        rejectCanvasStorageError(reject, 'canvas snapshot save transaction', error)
      }
    })

    await saveAutoSaveCanvasFile(
      storeKey,
      items,
      groups,
      groupBranches,
      figmaBinding,
      allBlobEntries
    )
  } catch (err) {
    const normalizedError = normalizeCanvasStorageError(err, '[Canvas Storage] Save failed.')
    console.error('[Canvas Storage] 保存失败:', normalizedError)
    throw normalizedError
  } finally {
    db?.close()
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
  let db: IDBDatabase | undefined
  let createdUrls: Map<string, string> | undefined
  try {
    db = await openDB()
    const { persisted, binaries } = await readIndexedDbCanvasSnapshot(db, storeKey)
    db.close()
    db = undefined

    if (persisted === undefined) {
      const projectSnapshot = await loadCanvasFallback(storeKey)
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
      const projectSnapshot = await loadCanvasFallback(storeKey)
      return projectSnapshot ?? { items: [], groups, groupBranches, figmaBinding }
    }

    // Resolve external project paths after the transaction. Only use binary
    // keys whose resolved item source was eligible under the legacy loader;
    // an unresolved relative path must not acquire a stale same-ID blob.
    const eligibleKeys = new Set<string>()
    for (const item of resolvedIndexedDbItems) {
      if (!isBlobPersistableCanvasItem(item) || (item.src && !hasLocallyPersistableCanvasSrc(item))) continue
      eligibleKeys.add(item.id)
      if (item.type === 'model3d' && item.textures) {
        for (const name of Object.keys(item.textures)) eligibleKeys.add(getModelTextureKey(item.id, name))
      }
    }
    createdUrls = createCanvasBlobUrlMap(new Map([...binaries].filter(([key]) => eligibleKeys.has(key))))
    const restoredItems = restorePersistedCanvasItems(resolvedIndexedDbItems, createdUrls)

    if (restoredItems.length === 0 && resolvedIndexedDbItems.length > 0) {
      for (const url of createdUrls.values()) URL.revokeObjectURL(url)
      createdUrls = undefined
      const projectSnapshot = await loadCanvasFallback(storeKey)
      return projectSnapshot ?? { items: [], groups, groupBranches, figmaBinding }
    }
    createdUrls = undefined // Ownership passes to the returned canvas items.
    return { items: restoredItems, groups, groupBranches, figmaBinding }
  } catch (err) {
    if (createdUrls) {
      for (const url of createdUrls.values()) URL.revokeObjectURL(url)
    }
    db?.close()
    db = undefined
    console.error(
      '[Canvas Storage] 加载失败:',
      normalizeCanvasStorageError(err, '[Canvas Storage] Load failed.')
    )
    const projectSnapshot = await loadCanvasFallback(storeKey)
    return projectSnapshot ?? { items: [], groups: [], groupBranches: [], figmaBinding: null }
  } finally {
    db?.close()
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

    await saveAutoSaveCanvasFile(storeKey, [], [], [], null, [])
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

  const receipt = await window.api.svcFs.saveImageToPath({
    image: buffer,
    outputPath: dirPath,
    filename: outFilename
  })
  if (receipt?.success !== true) {
    throw new Error('Native canvas save was not acknowledged.')
  }
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
  // Stage each snapshot under a fresh namespace; replacing a fixed asset path
  // before metadata commits can change the bytes referenced by the old file.
  // If randomness is unavailable, fail this mirror save rather than overwrite.
  const snapshotId = `snapshot-${crypto.randomUUID()}`
  const serializedItems = serializeItems(items)
  const assetFileNames = buildCanvasAssetFileNameMap(items)
  const projectAssetRefs = buildProjectAssetRefMap(items, snapshotId)
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
      // Crop hints do not authenticate their coordinate system, even when a
      // later hydration has backfilled source dimensions that match the bytes.
      // Keep the source and crop together in the mirror instead of flattening
      // and deleting potentially recoverable user content.
      const assetRef =
        projectAssetRefs.get(sourceItem.id) ||
        buildProjectAssetRef(sourceItem.id, resolvedFileName, sourceItem.type, snapshotId)
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
            buildProjectAssetRef(textureKey, textureName, 'texture', snapshotId)
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

const canvasImportAssetPersistenceError = (): Error =>
  new Error('Unable to persist MagicPot canvas import assets without overwriting existing data')

function closeCanvasImportAssetDatabase(db: IDBDatabase): void {
  try {
    db.close()
  } catch {
    // Closing must not replace a settled write outcome or inspect native diagnostics.
  }
}

// Explicit append only. Ordinary openDB intentionally retains its separate legacy error policy.
function openCanvasImportAssetDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let request: IDBOpenDBRequest
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION)
    } catch {
      reject(canvasImportAssetPersistenceError())
      return
    }
    let upgradeFailed = false
    request.onupgradeneeded = () => {
      if (upgradeFailed) return
      try {
        const db = request.result
        if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME)
        if (!db.objectStoreNames.contains(BLOB_STORE_NAME)) db.createObjectStore(BLOB_STORE_NAME)
      } catch {
        upgradeFailed = true
        try {
          request.transaction?.abort()
        } catch {
          // Abort invocation is not the terminal open outcome; keep waiting for error/success.
        }
      }
    }
    request.onerror = () => reject(canvasImportAssetPersistenceError())
    request.onsuccess = () => {
      const db = request.result
      if (upgradeFailed) {
        closeCanvasImportAssetDatabase(db)
        reject(canvasImportAssetPersistenceError())
      } else {
        resolve(db)
      }
    }
  })
}

async function persistNewCanvasFileEmbeddedAssets(
  blobs: Record<string, EmbeddedBlob> | undefined,
  storeKey: string,
  isCurrent?: () => boolean
): Promise<void> {
  if (isCurrent?.() === false || !blobs || Object.keys(blobs).length === 0) return
  let db: IDBDatabase | undefined
  try {
    // Finish all decoding before acquiring a write transaction, including unused embedded keys.
    const entries = Object.entries(blobs).map(([key, embedded]) => ({
      key,
      data: base64ToArrayBuffer(embedded.base64),
      mimeType: embedded.mimeType
    }))
    db = await openCanvasImportAssetDatabase()
    if (isCurrent?.() === false) return
    const database = db
    await new Promise<void>((resolve, reject) => {
      let tx: IDBTransaction
      try {
        tx = database.transaction(BLOB_STORE_NAME, 'readwrite')
      } catch {
        reject(canvasImportAssetPersistenceError())
        return
      }
      let failed = false
      let abortRequested = false
      const fail = (): void => {
        failed = true
        if (abortRequested) return
        abortRequested = true
        try {
          tx.abort()
        } catch {
          // Keep ownership until a real terminal event even when abort throws.
        }
      }
      tx.oncomplete = () => {
        if (failed) reject(canvasImportAssetPersistenceError())
        else resolve()
      }
      tx.onabort = () => reject(canvasImportAssetPersistenceError())
      tx.onerror = fail
      try {
        const store = tx.objectStore(BLOB_STORE_NAME)
        for (const entry of entries) {
          const request = store.add(
            { data: entry.data, mimeType: entry.mimeType },
            getScopedCanvasBlobKey(storeKey, entry.key)
          )
          request.onerror = fail
        }
      } catch {
        // Stop synchronous queueing. Request errors may arrive after other adds were queued.
        fail()
      }
    })
  } catch {
    // Never normalize, log, inspect or retain native failures, keys or payloads.
    throw canvasImportAssetPersistenceError()
  } finally {
    if (db) closeCanvasImportAssetDatabase(db)
  }
}

async function persistCanvasFileEmbeddedAssets(
  blobs: Record<string, EmbeddedBlob> | undefined,
  storeKey: string = KEY
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
    await saveBlobEntries(db, storeKey, entries)
    db.close()
    console.log(`[Canvas Import] Persisted ${entries.length} embedded assets to IndexedDB`)
  } catch (error) {
    console.warn('[Canvas Import] Failed to persist embedded assets', error)
  }
}

const emptyCanvasFileSnapshot = (): RestoredCanvasFileSnapshot => ({
  items: [], groups: [], groupBranches: [], figmaBinding: null
})

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
    requireNewEmbeddedAssets = false,
    canvasBaseDir,
    storeKey = KEY,
    isCurrent
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

  const restoredBlobUrls = new Map<string, string>()

  try {
    if (isCurrent?.() === false) return emptyCanvasFileSnapshot()
    for (const [blobKey, embedded] of Object.entries(data.blobs || {})) {
      const buffer = base64ToArrayBuffer(embedded.base64)
      const blob = new Blob([buffer], { type: embedded.mimeType })
      restoredBlobUrls.set(blobKey, URL.createObjectURL(blob))
    }

    if (isCurrent?.() === false) {
      for (const url of restoredBlobUrls.values()) URL.revokeObjectURL(url)
      return emptyCanvasFileSnapshot()
    }
    if (persistEmbeddedAssetsToIndexedDb) {
      if (requireNewEmbeddedAssets) await persistNewCanvasFileEmbeddedAssets(data.blobs, storeKey, isCurrent)
      else await persistCanvasFileEmbeddedAssets(data.blobs, storeKey)
    }
    if (isCurrent?.() === false) {
      for (const url of restoredBlobUrls.values()) URL.revokeObjectURL(url)
      return emptyCanvasFileSnapshot()
    }

    if (storageMode === 'project' && !canvasBaseDir) {
      console.error('[Canvas Import] Project canvas file is missing its base directory context.')
    }

    await validateProjectCanvasAssetRefs(data.items, canvasBaseDir, storageMode)
    if (isCurrent?.() === false) {
      for (const url of restoredBlobUrls.values()) URL.revokeObjectURL(url)
      return emptyCanvasFileSnapshot()
    }
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
  } catch (error) {
    for (const url of restoredBlobUrls.values()) {
      try {
        URL.revokeObjectURL(url)
      } catch {
        // Preserve the restore failure while still attempting to revoke every created URL.
      }
    }
    throw error
  }
}

// Native acknowledgement is not a durability/readback certificate; a browser click is only a request.
export type CanvasFileSaveOutcome =
  | Readonly<{ status: 'native-written' }>
  | Readonly<{ status: 'cancelled' }>
  | Readonly<{ status: 'download-requested' }>

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
  updateCurrentDocumentPath: boolean = true,
  onSaveDialogOpened?: () => void
): Promise<CanvasFileSaveOutcome> {
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
      return { status: 'native-written' }
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
      const saveDialogPromise = window.api.svcDialog.showSaveDialog({
        title: forceSaveAs ? 'Save Canvas As' : 'Save Canvas',
        defaultPath: cachedTargetPath || projectCanvasLocation?.canvasFullPath || name,
        filters: [{ name: 'MPCANVAS File', extensions: ['mpcanvas'] }]
      })
      onSaveDialogOpened?.()
      const res = await saveDialogPromise
      if (res.canceled || !res.filePath) {
        return { status: 'cancelled' }
      }
      targetPath = res.filePath
      // Preserve the existing pre-write target selection; the cache does not certify persistence.
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
      return { status: 'native-written' }
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
  return { status: 'download-requested' }
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
): Promise<CanvasFileSaveOutcome> {
  return await exportCanvasFile(
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

export async function importCanvasFile(
  file: File,
  targetStoreKey: string = KEY,
  isCurrent?: () => boolean
): Promise<{
  items: CanvasItem[]
  groups: CanvasGroup[]
  groupBranches: CanvasGroupBranch[]
  qAppKey?: string
  figmaBinding: CanvasFigmaBinding | null
}> {
  assertCanvasImportFileSize(file.size)
  const text = await file.text()
  if (isCurrent?.() === false) return emptyCanvasFileSnapshot()
  const data = parseCanvasImportText(text) as CanvasFileData
  const canvasFilePath = getElectronCanvasFilePath(file)
  const canvasBaseDir =
    canvasFilePath && window.path && typeof window.path.dirname === 'function'
      ? window.path.dirname(canvasFilePath)
      : undefined
  return await restoreCanvasFileData(data, {
    restoreQAppState: false,
    persistEmbeddedAssetsToIndexedDb: true,
    requireNewEmbeddedAssets: true,
    storeKey: targetStoreKey,
    canvasBaseDir,
    isCurrent
  })
}

/**
 * Detect whether a file is an .mpcanvas export.
 */
export function isCanvasFile(fileName: string): boolean {
  return fileName.toLowerCase().endsWith(CANVAS_FILE_EXT)
}
