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
import { getElectronCanvasFilePath } from './canvasLocalFileSource'
import { assertCanvasImportFileSize, parseCanvasImportText } from './canvasImportPreflight'
import {
  serializeCanvasItems as serializeItems,
  stripCanvasAssetKeyTags,
  type CanvasAssetKeyTagged,
  type SerializableCanvasItem
} from './canvasItemSerialization'

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


interface CanvasPersistedData {
  items: SerializableCanvasItem[]
  groups?: CanvasGroup[]
  groupBranches?: CanvasGroupBranch[]
  figmaBinding?: CanvasFigmaBinding | null
  /**
   * CANVAS_RECORD_ASSET_FORMAT on every record this version commits. Earlier
   * versions build their record afresh and drop it, so a record without it was
   * written (last) by a version that may have changed an image while carrying
   * the item's old `assetKey` through.
   */
  assetFormat?: number
  /**
   * Item id or model texture key -> the content key whose bytes the legacy
   * per-item blob (<storeKey>::canvas::<logicalKey>) holds. Only meaningful
   * on a record that carries `assetFormat`.
   */
  legacyBlobAssetKeys?: Record<string, string>
}

// Records with content-keyed items that also keep a per-item blob for the
// previous release (see the dual write in storeCanvasAssetBlobs).
const CANVAS_RECORD_ASSET_FORMAT = 2

function isCurrentFormatCanvasRecord(
  persisted: CanvasPersistedData | SerializableCanvasItem[] | undefined
): persisted is CanvasPersistedData {
  return (
    !!persisted &&
    !Array.isArray(persisted) &&
    (persisted as CanvasPersistedData).assetFormat === CANVAS_RECORD_ASSET_FORMAT
  )
}

function readCanvasRecordLegacyBlobAssetKeys(
  persisted: CanvasPersistedData | SerializableCanvasItem[] | undefined
): Map<string, string> {
  const keys = new Map<string, string>()
  if (!isCurrentFormatCanvasRecord(persisted)) return keys
  const raw = persisted.legacyBlobAssetKeys
  if (!raw || typeof raw !== 'object') return keys
  for (const [logicalKey, assetKey] of Object.entries(raw)) {
    if (isCanvasAssetKey(assetKey)) keys.set(logicalKey, assetKey)
  }
  return keys
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
}

type CanvasBinaryAssetResolveOptions = {
  allowIndexedDbFallback?: boolean
  /** Content key of the slot, when known: the fallback then reads the keyed blob first. */
  indexedDbAssetKey?: string
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

// Content-addressed blobs live next to the legacy per-item blobs, in their own namespace.
const CANVAS_ASSET_BLOB_KEY_PREFIX = 'asset::'

function getScopedCanvasAssetBlobKey(storeKey: string, assetKey: string): string {
  return getScopedCanvasBlobKey(storeKey, `${CANVAS_ASSET_BLOB_KEY_PREFIX}${assetKey}`)
}

// ─── Content keys ────────────────────────────────────────────────────────────
// A content key names the bytes behind one asset slot (an item's `src` or one
// model texture). Path-backed sources are keyed by their file identity (path,
// size, mtime); everything else by a SHA-256 of the bytes. A key is only ever
// trusted together with the source string it was computed for, so replacing an
// item's `src` always yields a new key, however the item object was copied.
const CANVAS_ASSET_KEY_HEX_LENGTH = 40
const CANVAS_ASSET_KEY_PATTERN = /^[bfu]-[0-9a-f]{40}$/
const CANVAS_ASSET_KEY_CACHE_LIMIT = 20_000
const CANVAS_ASSET_SOURCE_SLOT = 'src'

function isCanvasAssetKey(value: unknown): value is string {
  return typeof value === 'string' && CANVAS_ASSET_KEY_PATTERN.test(value)
}

function getCanvasTextureAssetSlot(textureName: string): string {
  return `tex:${textureName}`
}

const SHA256_ROUND_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
])

/** Plain SHA-256 for contexts without SubtleCrypto (insecure origins, test doubles). */
function sha256HexFallback(bytes: Uint8Array): string {
  const state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
  ])
  const bitLength = bytes.byteLength * 8
  const paddedLength = (((bytes.byteLength + 8) >> 6) + 1) << 6
  const padded = new Uint8Array(paddedLength)
  padded.set(bytes)
  padded[bytes.byteLength] = 0x80
  const view = new DataView(padded.buffer)
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000))
  view.setUint32(paddedLength - 4, bitLength >>> 0)
  const words = new Uint32Array(64)
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(offset + index * 4)
    for (let index = 16; index < 64; index += 1) {
      const w15 = words[index - 15]
      const w2 = words[index - 2]
      const s0 = ((w15 >>> 7) | (w15 << 25)) ^ ((w15 >>> 18) | (w15 << 14)) ^ (w15 >>> 3)
      const s1 = ((w2 >>> 17) | (w2 << 15)) ^ ((w2 >>> 19) | (w2 << 13)) ^ (w2 >>> 10)
      words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0
    }
    let [a, b, c, d, e, f, g, h] = state
    for (let index = 0; index < 64; index += 1) {
      const s1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))
      const ch = (e & f) ^ (~e & g)
      const t1 = (h + s1 + ch + SHA256_ROUND_CONSTANTS[index] + words[index]) >>> 0
      const s0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const t2 = (s0 + maj) >>> 0
      h = g
      g = f
      f = e
      e = (d + t1) >>> 0
      d = c
      c = b
      b = a
      a = (t1 + t2) >>> 0
    }
    state[0] = (state[0] + a) >>> 0
    state[1] = (state[1] + b) >>> 0
    state[2] = (state[2] + c) >>> 0
    state[3] = (state[3] + d) >>> 0
    state[4] = (state[4] + e) >>> 0
    state[5] = (state[5] + f) >>> 0
    state[6] = (state[6] + g) >>> 0
    state[7] = (state[7] + h) >>> 0
  }
  return Array.from(state, (word) => word.toString(16).padStart(8, '0')).join('')
}

async function sha256Hex(data: ArrayBuffer | Uint8Array): Promise<string> {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
  const subtle = globalThis.crypto?.subtle
  if (subtle && typeof subtle.digest === 'function') {
    try {
      const digest = await subtle.digest('SHA-256', bytes as BufferSource)
      return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(
        ''
      )
    } catch {
      // Fall through to the plain implementation; a missing key must never block a save.
    }
  }
  return sha256HexFallback(bytes)
}

async function buildCanvasContentAssetKey(data: ArrayBuffer): Promise<string> {
  return `b-${(await sha256Hex(data)).slice(0, CANVAS_ASSET_KEY_HEX_LENGTH)}`
}

function getCanvasFileIdentityCacheId(
  canonicalPath: string,
  sizeBytes: number,
  lastModifiedMs: number
): string {
  return `file-identity\n${canonicalPath}\n${Math.floor(sizeBytes)}\n${Math.floor(lastModifiedMs)}`
}

async function buildCanvasFileIdentityAssetKey(
  canonicalPath: string,
  sizeBytes: number,
  lastModifiedMs: number
): Promise<string> {
  const identity = `canvas-asset-file-v1\n${canonicalPath}\n${Math.floor(sizeBytes)}\n${Math.floor(lastModifiedMs)}`
  const digest = await sha256Hex(new TextEncoder().encode(identity))
  return `f-${digest.slice(0, CANVAS_ASSET_KEY_HEX_LENGTH)}`
}

// Per item object: valid while the object is alive and its source is unchanged.
const canvasAssetKeyBySlot = new WeakMap<
  object,
  Map<string, { src: string; sourceFile: Blob | undefined; key: string }>
>()
// An attached source file is the authoritative content of its item.
const canvasAssetKeyBySourceFile = new WeakMap<Blob, string>()
// Sources whose bytes cannot change: object URLs and (path, size, mtime) identities.
const canvasAssetKeyByImmutableSource = new Map<string, string>()
// Object URLs seen with two different contents (only possible when an attached
// source file disagrees with its URL); these are never trusted by URL again.
const canvasAmbiguousObjectUrls = new Set<string>()
// Last key seen for a path-backed source. Only ever used to keep assets
// (a wider set is always safe), never to decide that bytes need no writing.
const canvasAssetKeyHintBySource = new Map<string, string>()
// Object URLs made from the per-item blob of one item (`<storeKey>\n<logicalKey>`
// plus the generation of that blob): their bytes are that blob's bytes, so the
// save that keys them needs no second per-item copy for the previous release.
const canvasLegacyBlobByObjectUrl = new Map<string, string>()
// Bumped whenever this session rewrites a per-item blob; older object URLs then no longer match it.
const canvasLegacyBlobGeneration = new Map<string, number>()

function getCanvasLegacyBlobId(storeKey: string, logicalKey: string): string {
  const id = `${storeKey}\n${logicalKey}`
  return `${id}\n${canvasLegacyBlobGeneration.get(id) ?? 0}`
}

function rememberCanvasLegacyBlobObjectUrl(url: string, storeKey: string, logicalKey: string): void {
  rememberBoundedCanvasAssetKey(
    canvasLegacyBlobByObjectUrl,
    url,
    getCanvasLegacyBlobId(storeKey, logicalKey)
  )
}

function noteCanvasLegacyBlobRewritten(storeKey: string, logicalKey: string): void {
  const id = `${storeKey}\n${logicalKey}`
  canvasLegacyBlobGeneration.set(id, (canvasLegacyBlobGeneration.get(id) ?? 0) + 1)
}

function rememberBoundedCanvasAssetKey(cache: Map<string, string>, id: string, key: string): void {
  cache.delete(id)
  cache.set(id, key)
  while (cache.size > CANVAS_ASSET_KEY_CACHE_LIMIT) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
}

function rememberCanvasImmutableAssetKey(cacheId: string, key: string): void {
  rememberBoundedCanvasAssetKey(canvasAssetKeyByImmutableSource, cacheId, key)
}

function getCanvasAssetSlotSourceFile(owner: object, slotId: string): Blob | undefined {
  if (slotId !== CANVAS_ASSET_SOURCE_SLOT) return undefined
  const sourceFile = (owner as { sourceFile?: unknown }).sourceFile
  return typeof Blob !== 'undefined' && sourceFile instanceof Blob ? sourceFile : undefined
}

function rememberCanvasAssetKey(
  owner: object,
  slotId: string,
  src: string,
  key: string,
  derivedFrom: 'file-identity' | 'content'
): void {
  const sourceFile = getCanvasAssetSlotSourceFile(owner, slotId)
  let slots = canvasAssetKeyBySlot.get(owner)
  if (!slots) {
    slots = new Map()
    canvasAssetKeyBySlot.set(owner, slots)
  }
  slots.set(slotId, { src, sourceFile, key })
  if (derivedFrom === 'file-identity') {
    rememberBoundedCanvasAssetKey(canvasAssetKeyHintBySource, src, key)
    return
  }
  if (sourceFile) canvasAssetKeyBySourceFile.set(sourceFile, key)
  if (src.startsWith('blob:') && !canvasAmbiguousObjectUrls.has(src)) {
    const previous = canvasAssetKeyByImmutableSource.get(src)
    if (previous !== undefined && previous !== key) {
      canvasAssetKeyByImmutableSource.delete(src)
      canvasAmbiguousObjectUrls.add(src)
    } else {
      rememberCanvasImmutableAssetKey(src, key)
    }
  }
}

function readCanvasAssetKeyTag(owner: object, slotId: string, src: string): string | null {
  const tagged = owner as CanvasAssetKeyTagged
  if (slotId === CANVAS_ASSET_SOURCE_SLOT) {
    return isCanvasAssetKey(tagged.assetKey) && tagged.assetKeySource === src
      ? tagged.assetKey
      : null
  }
  const textureName = slotId.startsWith('tex:') ? slotId.slice('tex:'.length) : null
  if (
    textureName === null ||
    !tagged.textureAssetKeys ||
    typeof tagged.textureAssetKeys !== 'object' ||
    !tagged.textureAssetKeySources ||
    typeof tagged.textureAssetKeySources !== 'object'
  ) {
    return null
  }
  const keys = tagged.textureAssetKeys as Record<string, unknown>
  const sources = tagged.textureAssetKeySources as Record<string, unknown>
  if (!Object.prototype.hasOwnProperty.call(keys, textureName)) return null
  const key = keys[textureName]
  return isCanvasAssetKey(key) && sources[textureName] === src ? key : null
}

function getMatchingLocalFileIdentity(
  owner: object,
  slotId: string,
  src: string
): { canonicalPath: string; sizeBytes: number; lastModifiedMs: number } | null {
  if (slotId !== CANVAS_ASSET_SOURCE_SLOT) return null
  const identity = (owner as { sourceIdentity?: CanvasImageItem['sourceIdentity'] }).sourceIdentity
  if (
    !identity ||
    identity.kind !== 'local-file' ||
    !identity.canonicalPath ||
    !(identity.sizeBytes > 0) ||
    !(identity.lastModifiedMs > 0)
  ) {
    return null
  }
  const localPath = resolveLocalFilePathFromSource(src)
  if (!localPath) return null
  const comparable = (value: string): string => normalizeComparablePath(value).replace(/^\/+/, '')
  return comparable(localPath) === comparable(identity.canonicalPath)
    ? {
        canonicalPath: identity.canonicalPath,
        sizeBytes: identity.sizeBytes,
        lastModifiedMs: identity.lastModifiedMs
      }
    : null
}

const CANVAS_MANAGED_MEDIA_SHA256_PATTERN = /^[0-9a-f]{64}$/

/**
 * The content key of a managed image, from the SHA-256 its media reference
 * records: it does not depend on the managed file still existing. Only for the
 * source of a managed image whose src still is that managed file (its path
 * ends with the reference's relative path).
 */
function getManagedMediaCanvasAssetKey(owner: object, slotId: string, src: string): string | null {
  if (slotId !== CANVAS_ASSET_SOURCE_SLOT) return null
  const candidate = owner as { type?: unknown; media?: { kind?: unknown; sha256?: unknown; relativePath?: unknown } }
  const media = candidate.media
  if (
    candidate.type !== 'image' ||
    !media ||
    media.kind !== 'managed' ||
    typeof media.sha256 !== 'string' ||
    !CANVAS_MANAGED_MEDIA_SHA256_PATTERN.test(media.sha256.toLowerCase()) ||
    typeof media.relativePath !== 'string' ||
    !media.relativePath
  ) {
    return null
  }
  const localPath = resolveLocalFilePathFromSource(src)
  if (!localPath) return null
  const comparable = (value: string): string => value.replace(/[\\/]+/g, '/').toLowerCase()
  if (!comparable(localPath).endsWith(`/${comparable(media.relativePath).replace(/^\/+/, '')}`)) {
    return null
  }
  return `b-${media.sha256.toLowerCase().slice(0, CANVAS_ASSET_KEY_HEX_LENGTH)}`
}

/**
 * A key this session already knows for the slot; never reads bytes and never
 * waits. Order: the file identity of a path-backed image, the item object
 * itself, an attached source file, the tag of a restored item, the object URL.
 */
function peekCanvasAssetKey(owner: object, slotId: string, src: string): string | null {
  const managedKey = getManagedMediaCanvasAssetKey(owner, slotId, src)
  if (managedKey) return managedKey
  const identity = getMatchingLocalFileIdentity(owner, slotId, src)
  if (identity) {
    return (
      canvasAssetKeyByImmutableSource.get(
        getCanvasFileIdentityCacheId(
          identity.canonicalPath,
          identity.sizeBytes,
          identity.lastModifiedMs
        )
      ) ?? null
    )
  }
  const sourceFile = getCanvasAssetSlotSourceFile(owner, slotId)
  const cached = canvasAssetKeyBySlot.get(owner)?.get(slotId)
  if (cached && cached.src === src && cached.sourceFile === sourceFile) return cached.key
  if (sourceFile) return canvasAssetKeyBySourceFile.get(sourceFile) ?? null
  const tagged = readCanvasAssetKeyTag(owner, slotId, src)
  if (tagged) return tagged
  return src.startsWith('blob:') ? (canvasAssetKeyByImmutableSource.get(src) ?? null) : null
}

async function readCanvasLocalSourceFileIdentity(
  localPath: string
): Promise<{ canonicalPath: string; sizeBytes: number; lastModifiedMs: number } | null> {
  const thumbnailService = window.api?.svcCanvasThumbnail
  if (!thumbnailService || typeof thumbnailService.getSourceFileMetadata !== 'function') {
    return null
  }
  try {
    const metadata = await thumbnailService.getSourceFileMetadata({ fullPath: localPath })
    if (
      !metadata?.exists ||
      !metadata.canonicalPath ||
      !(metadata.sizeBytes >= 0) ||
      !(metadata.lastModifiedMs > 0)
    ) {
      return null
    }
    return {
      canonicalPath: metadata.canonicalPath,
      sizeBytes: metadata.sizeBytes,
      lastModifiedMs: metadata.lastModifiedMs
    }
  } catch {
    return null
  }
}

const CANVAS_MIRROR_ASSET_PATH_PATTERN = /[\\/]assets[\\/]([bfu]-[0-9a-f]{40})(?:\.[a-z0-9]{1,16})?$/

/**
 * The content key of a file written by the mirror save, i.e. a path of the
 * form <autoSaveRoot>/<projectDir>/assets/<key>[.ext]. Such a file is
 * published once under its key and never replaced, so its name is its key.
 */
async function readCanvasMirrorAssetKeyFromPath(localPath: string): Promise<string | null> {
  const match = CANVAS_MIRROR_ASSET_PATH_PATTERN.exec(localPath)
  if (!match) return null
  const autoSaveRoot = await resolveAutoSaveRootPath()
  if (!autoSaveRoot) return null
  const comparable = (value: string): string =>
    value.replace(/[\\/]+/g, '/').replace(/^\/+|\/+$/g, '').toLowerCase()
  const root = comparable(autoSaveRoot)
  const file = comparable(localPath)
  if (!root || !file.startsWith(`${root}/`)) return null
  const segments = file.slice(root.length + 1).split('/')
  if (
    segments.length !== 3 ||
    segments[1] !== 'assets' ||
    segments.some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    return null
  }
  return match[1]
}

/**
 * The key of a path-backed slot, from the item's own local-file identity or a
 * stat of the file. Returns null for sources that are not local files (their
 * key needs the bytes) and when the file cannot be inspected.
 */
async function resolveCanvasFileIdentityAssetKey(
  owner: object,
  slotId: string,
  src: string
): Promise<string | null> {
  const localPath = resolveLocalFilePathFromSource(src)
  if (!localPath) return null

  // A board restored from the autosave mirror points at the mirror's own
  // content-keyed files: keep their keys instead of keying the copy afresh,
  // so the next save neither stores nor mirrors those bytes a second time.
  const mirrorKey = await readCanvasMirrorAssetKeyFromPath(localPath)
  if (mirrorKey) {
    rememberCanvasAssetKey(owner, slotId, src, mirrorKey, 'file-identity')
    return mirrorKey
  }

  const itemIdentity = getMatchingLocalFileIdentity(owner, slotId, src)
  if (itemIdentity) {
    const key = await buildCanvasFileIdentityAssetKey(
      itemIdentity.canonicalPath,
      itemIdentity.sizeBytes,
      itemIdentity.lastModifiedMs
    )
    rememberCanvasImmutableAssetKey(
      getCanvasFileIdentityCacheId(
        itemIdentity.canonicalPath,
        itemIdentity.sizeBytes,
        itemIdentity.lastModifiedMs
      ),
      key
    )
    rememberCanvasAssetKey(owner, slotId, src, key, 'file-identity')
    return key
  }

  // Without an identity on the item the file is inspected again whenever the
  // item object changed, so a file replaced on disk is never mistaken for the old one.
  const fileIdentity = await readCanvasLocalSourceFileIdentity(localPath)
  if (!fileIdentity) return null
  const key = await buildCanvasFileIdentityAssetKey(
    fileIdentity.canonicalPath,
    fileIdentity.sizeBytes,
    fileIdentity.lastModifiedMs
  )
  rememberCanvasAssetKey(owner, slotId, src, key, 'file-identity')
  return key
}

/** Resolves the key of one slot; `readBytes` is only called when the key needs the content. */
async function resolveCanvasAssetKey(
  owner: object,
  slotId: string,
  src: string,
  readBytes: () => Promise<ArrayBuffer | null>
): Promise<string | null> {
  const known = peekCanvasAssetKey(owner, slotId, src)
  if (known) return known
  const fromFile = await resolveCanvasFileIdentityAssetKey(owner, slotId, src)
  if (fromFile) return fromFile
  const bytes = await readBytes()
  if (!bytes) return null
  const key = await buildCanvasContentAssetKey(bytes)
  rememberCanvasAssetKey(owner, slotId, src, key, 'content')
  return key
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

function decodeLocalFilePathPart(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/**
 * The file-system path behind a local-media / file URL or a plain absolute
 * path; null for every other source. `local-media:///C:/a.png` is a drive
 * path, `local-media:///home/a.png` a POSIX path (the leading slash belongs to
 * it) and `local-media://server/share/a.png` a UNC path.
 */
function resolveLocalFilePathFromSource(sourceUrl: string): string | null {
  const normalized = normalizeLocalMediaUrl(sourceUrl).trim()
  if (!normalized) {
    return null
  }

  const scheme = ['local-media://', 'file://'].find((prefix) => normalized.startsWith(prefix))
  if (!scheme) {
    return null
  }

  const rest = normalized.slice(scheme.length)
  if (!rest.startsWith('/')) {
    const decoded = decodeLocalFilePathPart(rest)
    if (!decoded) return null
    // Legacy two-slash drive form, otherwise host/share/...
    return /^[a-zA-Z]:([\\/]|$)/.test(decoded) ? decoded : `//${decoded}`
  }

  const decoded = decodeLocalFilePathPart(rest.slice(1))
  if (!decoded) return null
  if (/^[a-zA-Z]:([\\/]|$)/.test(decoded)) return decoded
  if (/^[\\/]/.test(decoded)) return `//${decoded.replace(/^[\\/]+/, '')}`
  return `/${decoded}`
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
  storeKey?: string,
  assetKey?: string
): Promise<{ data: ArrayBuffer; mimeType: string } | null> {
  try {
    const db = await openDB()
    const tx = db.transaction(BLOB_STORE_NAME, 'readonly')
    const store = tx.objectStore(BLOB_STORE_NAME)
    const assetResultPromise =
      storeKey && assetKey
        ? readBlobStoreEntry(store, getScopedCanvasAssetBlobKey(storeKey, assetKey))
        : Promise.resolve(undefined)
    const scopedResultPromise = storeKey
      ? readBlobStoreEntry(store, getScopedCanvasBlobKey(storeKey, key))
      : Promise.resolve(undefined)
    const legacyResultPromise = readBlobStoreEntry(store, key)
    const [assetResult, scopedResult, legacyResult] = await Promise.all([
      assetResultPromise,
      scopedResultPromise,
      legacyResultPromise
    ])
    const result = assetResult || scopedResult || legacyResult
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
  options: CanvasBinaryAssetResolveOptions = {}
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
      : await readIndexedDbBinaryAsset(key, storeKey, options.indexedDbAssetKey)
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
  options?: CanvasBinaryAssetResolveOptions
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

function normalizeComparablePath(value: string): string {
  return value.replace(/[\\/]+/g, '/').toLowerCase()
}

function toLocalMediaUrl(fullPath: string): string {
  // A UNC path keeps its host in the authority part; everything else is a path.
  if (/^[\\/]{2}[^\\/]/.test(fullPath)) {
    return `local-media://${fullPath.replace(/[\\/]+/g, '/').replace(/^\/+/, '')}`
  }
  return `local-media:///${fullPath.replace(/[\\/]+/g, '/').replace(/^\/+/, '')}`
}

function normalizeProjectAssetRef(assetRef: string): string {
  return assetRef
    .replace(/[\\/]+/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
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

type CanvasBlobSnapshotRead = {
  /** Item id or model texture key: the name the restored binary is filed under. */
  logicalKey: string
  /** Content key recorded on the item, when it has one. */
  assetKey?: string
}

function queueLegacyCanvasBlobSnapshotRead(
  store: IDBObjectStore,
  storeKey: string,
  logicalKey: string,
  target: Map<string, CanvasStoredBinary>,
  onResult: (found: boolean) => void = () => {}
): void {
  const scopedRequest = store.get(getScopedCanvasBlobKey(storeKey, logicalKey))
  const legacyRequest = store.get(logicalKey)
  let scopedResult: CanvasStoredBinary | undefined
  let legacyResult: CanvasStoredBinary | undefined
  let completed = 0
  const finish = () => {
    if (++completed !== 2) return
    const result = scopedResult || legacyResult
    if (result) target.set(logicalKey, result)
    onResult(!!result)
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

// Enqueue these reads while the metadata request's transaction is active.
// Blob URLs are created only after the combined readonly transaction commits.
// A content-keyed blob is read once however many items share it; an item
// without a key, or whose keyed blob is missing, falls back to the per-item
// blobs written by earlier versions. With `preferLegacy` (a record written
// last by an earlier version, which may have changed an image while carrying
// the old key through) the per-item blob comes first and the keyed blob is
// only the fallback.
function queueCanvasBlobSnapshotReads(
  store: IDBObjectStore,
  storeKey: string,
  reads: readonly CanvasBlobSnapshotRead[],
  target: Map<string, CanvasStoredBinary>,
  resolvedByAssetKey: Set<string>,
  resolvedByLegacyBlob: Set<string>,
  preferLegacy: boolean
): void {
  const logicalKeysByAssetKey = new Map<string, string[]>()
  const queuedLegacyKeys = new Set<string>()
  const queueLegacy = (logicalKey: string, onMissing?: () => void): void => {
    if (queuedLegacyKeys.has(logicalKey)) return
    queuedLegacyKeys.add(logicalKey)
    queueLegacyCanvasBlobSnapshotRead(store, storeKey, logicalKey, target, (found) => {
      if (found) resolvedByLegacyBlob.add(logicalKey)
      else onMissing?.()
    })
  }
  const queueKeyed = (assetKey: string, logicalKeys: readonly string[], fallBack: boolean): void => {
    const request = store.get(getScopedCanvasAssetBlobKey(storeKey, assetKey))
    request.onsuccess = () => {
      const result = request.result as CanvasStoredBinary | undefined
      if (!result) {
        if (fallBack) for (const logicalKey of logicalKeys) queueLegacy(logicalKey)
        return
      }
      for (const logicalKey of logicalKeys) {
        target.set(logicalKey, result)
        resolvedByAssetKey.add(logicalKey)
      }
    }
  }

  for (const read of reads) {
    if (!read.assetKey) {
      queueLegacy(read.logicalKey)
      continue
    }
    if (preferLegacy) {
      const assetKey = read.assetKey
      queueLegacy(read.logicalKey, () => queueKeyed(assetKey, [read.logicalKey], false))
      continue
    }
    const sharers = logicalKeysByAssetKey.get(read.assetKey)
    if (sharers) {
      if (!sharers.includes(read.logicalKey)) sharers.push(read.logicalKey)
    } else {
      logicalKeysByAssetKey.set(read.assetKey, [read.logicalKey])
    }
  }

  for (const [assetKey, logicalKeys] of logicalKeysByAssetKey) {
    queueKeyed(assetKey, logicalKeys, true)
  }
}

async function readIndexedDbCanvasSnapshot(
  db: IDBDatabase,
  storeKey: string
): Promise<{
  persisted: CanvasPersistedData | SerializableCanvasItem[] | undefined
  binaries: Map<string, CanvasStoredBinary>
  /** Logical keys whose binary was read through the content key recorded on the item. */
  resolvedByAssetKey: Set<string>
  /** Logical keys whose binary was read from the per-item blob of that very item. */
  resolvedByLegacyBlob: Set<string>
}> {
  return await new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_NAME, BLOB_STORE_NAME], 'readonly')
    const binaries = new Map<string, CanvasStoredBinary>()
    const resolvedByAssetKey = new Set<string>()
    const resolvedByLegacyBlob = new Set<string>()
    let persisted: CanvasPersistedData | SerializableCanvasItem[] | undefined
    tx.oncomplete = () => resolve({ persisted, binaries, resolvedByAssetKey, resolvedByLegacyBlob })
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
          const reads = blobBackedItems.flatMap((item): CanvasBlobSnapshotRead[] => {
            const persistedKeys = readPersistedCanvasAssetKeys(item)
            return [
              { logicalKey: item.id, assetKey: persistedKeys.assetKey },
              ...(item.type === 'model3d' && item.textures
                ? Object.keys(item.textures).map((name) => ({
                    logicalKey: getModelTextureKey(item.id, name),
                    assetKey: persistedKeys.textureAssetKeys[name]
                  }))
                : [])
            ]
          })
          queueCanvasBlobSnapshotReads(
            tx.objectStore(BLOB_STORE_NAME),
            storeKey,
            reads,
            binaries,
            resolvedByAssetKey,
            resolvedByLegacyBlob,
            !isCurrentFormatCanvasRecord(persisted)
          )
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
  // Items that share one stored binary share one object URL (and one Blob).
  const urlByBinary = new Map<CanvasStoredBinary, string>()
  try {
    for (const [key, value] of binaries) {
      let url = urlByBinary.get(value)
      if (url === undefined) {
        url = URL.createObjectURL(new Blob([value.data], { type: value.mimeType }))
        urlByBinary.set(value, url)
      }
      urls.set(key, url)
    }
    return urls
  } catch (error) {
    for (const url of urlByBinary.values()) URL.revokeObjectURL(url)
    throw error
  }
}

/** The content keys recorded on a persisted item; anything malformed is ignored. */
function readPersistedCanvasAssetKeys(item: object): {
  assetKey?: string
  textureAssetKeys: Record<string, string>
} {
  const tagged = item as CanvasAssetKeyTagged
  const textureAssetKeys: Record<string, string> = {}
  if (tagged.textureAssetKeys && typeof tagged.textureAssetKeys === 'object') {
    for (const [name, key] of Object.entries(tagged.textureAssetKeys as Record<string, unknown>)) {
      if (isCanvasAssetKey(key)) textureAssetKeys[name] = key
    }
  }
  return {
    ...(isCanvasAssetKey(tagged.assetKey) ? { assetKey: tagged.assetKey } : {}),
    textureAssetKeys
  }
}

/**
 * Binds the content keys of a restored item to the object URLs just created
 * from those keyed blobs, so the next save recognises the assets without
 * reading them. A key whose binary came from anywhere else is dropped.
 */
function tagRestoredCanvasItemAssetKeys(
  item: CanvasItem,
  restoredBlobUrls: ReadonlyMap<string, string>,
  resolvedByAssetKey: ReadonlySet<string>
): CanvasItem {
  if (!isBlobPersistableCanvasItem(item)) return item
  const persistedKeys = readPersistedCanvasAssetKeys(item)
  const untagged = stripCanvasAssetKeyTags(item)
  const tags: CanvasAssetKeyTagged = {}
  if (
    persistedKeys.assetKey &&
    resolvedByAssetKey.has(item.id) &&
    item.src &&
    restoredBlobUrls.get(item.id) === item.src
  ) {
    tags.assetKey = persistedKeys.assetKey
    tags.assetKeySource = item.src
  }
  if (item.type === 'model3d' && item.textures) {
    const textureAssetKeys: Record<string, string> = {}
    const textureAssetKeySources: Record<string, string> = {}
    for (const [textureName, textureUrl] of Object.entries(item.textures)) {
      const textureKey = getModelTextureKey(item.id, textureName)
      const assetKey = persistedKeys.textureAssetKeys[textureName]
      if (
        assetKey &&
        resolvedByAssetKey.has(textureKey) &&
        restoredBlobUrls.get(textureKey) === textureUrl
      ) {
        textureAssetKeys[textureName] = assetKey
        textureAssetKeySources[textureName] = textureUrl
      }
    }
    if (Object.keys(textureAssetKeys).length > 0) {
      tags.textureAssetKeys = textureAssetKeys
      tags.textureAssetKeySources = textureAssetKeySources
    }
  }
  return Object.keys(tags).length > 0 || untagged !== item
    ? ({ ...untagged, ...tags } as CanvasItem)
    : item
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

// ─── Content-addressed blob store ────────────────────────────────────────────

/** One binary a save has to keep: an item's source or one blob-backed model texture. */
type CanvasBlobStoreSlot = {
  owner: BlobPersistableCanvasItem
  slotId: string
  /** Item id or model texture key; names the slot in errors and in mirror seeds. */
  logicalKey: string
  src: string
  fileName: string
  fallbackMimeType: string
}

type CanvasBlobKeyIndex = {
  /** Content keys stored for this canvas. */
  assetKeys: Set<string>
  /** Per-item blob keys written by earlier versions (logical form, without the scope prefix). */
  legacyKeys: Set<string>
}

const CANVAS_BLOB_WRITE_CONCURRENCY = 3
const CANVAS_BLOB_BATCH_MAX_ENTRIES = 16
const CANVAS_BLOB_BATCH_MAX_BYTES = 32 * 1024 * 1024

function collectCanvasBlobStoreSlots(items: readonly CanvasItem[]): CanvasBlobStoreSlot[] {
  const slots: CanvasBlobStoreSlot[] = []
  for (const item of items) {
    if (!isBlobPersistableCanvasItem(item)) continue
    const blobItem = item as BlobPersistableCanvasItem
    if (
      hasLocallyPersistableCanvasSrc(blobItem) &&
      !(blobItem.type === 'image' && blobItem.media?.kind === 'managed')
    ) {
      const fileName = blobItem.fileName || blobItem.id
      slots.push({
        owner: blobItem,
        slotId: CANVAS_ASSET_SOURCE_SLOT,
        logicalKey: blobItem.id,
        src: blobItem.src,
        fileName,
        fallbackMimeType: guessMimeType(fileName)
      })
    }
    if (blobItem.type === 'model3d' && blobItem.textures) {
      for (const [textureName, textureUrl] of Object.entries(blobItem.textures)) {
        if (!textureUrl.startsWith('blob:')) continue
        slots.push({
          owner: blobItem,
          slotId: getCanvasTextureAssetSlot(textureName),
          logicalKey: getModelTextureKey(blobItem.id, textureName),
          src: textureUrl,
          fileName: textureName,
          fallbackMimeType: guessTextureMimeType(textureName)
        })
      }
    }
  }
  return slots
}

async function readCanvasBlobStoreSlotBytes(
  slot: CanvasBlobStoreSlot,
  storeKey: string
): Promise<ResolvedCanvasBinaryAsset | null> {
  return slot.slotId === CANVAS_ASSET_SOURCE_SLOT
    ? await resolveCanvasBinaryAssetForItem(
        slot.owner,
        slot.logicalKey,
        slot.src,
        slot.fileName,
        slot.fallbackMimeType,
        storeKey
      )
    : await resolveCanvasBinaryAsset(
        slot.logicalKey,
        slot.src,
        slot.fileName,
        slot.fallbackMimeType,
        storeKey
      )
}

function getCanvasBlobKeyRange(storeKey: string): IDBKeyRange | undefined {
  try {
    if (typeof IDBKeyRange === 'undefined') return undefined
    const prefix = getScopedCanvasBlobKeyPrefix(storeKey)
    return IDBKeyRange.bound(prefix, `${prefix}￿`)
  } catch {
    return undefined
  }
}

/**
 * Lists the blob keys of one canvas inside the caller's transaction. Calls back
 * with null where key enumeration is not available; callers then behave as if
 * nothing were known about the store (write everything, delete nothing).
 */
function listCanvasBlobKeys(
  store: IDBObjectStore,
  storeKey: string,
  onKeys: (index: CanvasBlobKeyIndex | null) => void
): void {
  if (typeof (store as Partial<IDBObjectStore>).getAllKeys !== 'function') {
    onKeys(null)
    return
  }
  let request: IDBRequest<IDBValidKey[]>
  try {
    const range = getCanvasBlobKeyRange(storeKey)
    request = range ? store.getAllKeys(range) : store.getAllKeys()
  } catch {
    onKeys(null)
    return
  }
  request.onsuccess = () => {
    const index: CanvasBlobKeyIndex = { assetKeys: new Set(), legacyKeys: new Set() }
    for (const rawKey of request.result || []) {
      const logicalKey = getLogicalCanvasBlobKey(storeKey, String(rawKey))
      if (logicalKey === null) continue
      const assetKey = logicalKey.startsWith(CANVAS_ASSET_BLOB_KEY_PREFIX)
        ? logicalKey.slice(CANVAS_ASSET_BLOB_KEY_PREFIX.length)
        : null
      if (assetKey !== null && isCanvasAssetKey(assetKey)) index.assetKeys.add(assetKey)
      else index.legacyKeys.add(logicalKey)
    }
    onKeys(index)
  }
  // Request errors abort the transaction; do not prevent their default action.
}

type CanvasSaveBaseline = {
  index: CanvasBlobKeyIndex | null
  /** From the committed record: which content key each per-item blob holds. */
  legacyBlobAssetKeys: Map<string, string>
}

async function readCanvasSaveBaseline(
  db: IDBDatabase,
  storeKey: string
): Promise<CanvasSaveBaseline> {
  return await new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_NAME, BLOB_STORE_NAME], 'readonly')
    let index: CanvasBlobKeyIndex | null = null
    let legacyBlobAssetKeys = new Map<string, string>()
    tx.oncomplete = () => resolve({ index, legacyBlobAssetKeys })
    tx.onabort = () => rejectCanvasStorageError(reject, 'blob key index transaction', tx.error)
    tx.onerror = () => rejectCanvasStorageError(reject, 'blob key index transaction', tx.error)
    try {
      listCanvasBlobKeys(tx.objectStore(BLOB_STORE_NAME), storeKey, (result) => {
        index = result
      })
      const itemStore = tx.objectStore(STORE_NAME)
      if (typeof (itemStore as Partial<IDBObjectStore>).get === 'function') {
        const request = itemStore.get(storeKey)
        request.onsuccess = () => {
          legacyBlobAssetKeys = readCanvasRecordLegacyBlobAssetKeys(
            request.result as CanvasPersistedData | SerializableCanvasItem[] | undefined
          )
        }
      }
    } catch (error) {
      try { tx.abort() } catch { /* Already inactive. */ }
      rejectCanvasStorageError(reject, 'blob key index transaction', error)
    }
  })
}

type CanvasAssetBlobWrite = { assetKey: string; data: ArrayBuffer; mimeType: string }
/** A per-item blob of the previous release, copied from the keyed blob of `assetKey`. */
type CanvasLegacyBlobWrite = { logicalKey: string; assetKey: string }

async function writeCanvasAssetBlobBatch(
  db: IDBDatabase,
  storeKey: string,
  batch: readonly CanvasAssetBlobWrite[]
): Promise<void> {
  if (batch.length === 0) return
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([BLOB_STORE_NAME], 'readwrite')
    tx.oncomplete = () => resolve()
    tx.onabort = () => rejectCanvasStorageError(reject, 'canvas asset save transaction', tx.error)
    tx.onerror = () => rejectCanvasStorageError(reject, 'canvas asset save transaction', tx.error)
    try {
      const store = tx.objectStore(BLOB_STORE_NAME)
      for (const entry of batch) {
        store.put(
          { data: entry.data, mimeType: entry.mimeType },
          getScopedCanvasAssetBlobKey(storeKey, entry.assetKey)
        )
      }
    } catch (error) {
      try { tx.abort() } catch { /* Already inactive. */ }
      rejectCanvasStorageError(reject, 'canvas asset save transaction', error)
    }
  })
}

/**
 * Makes sure the bytes of every slot are stored under their content key and
 * returns the key of each slot. Bytes are read only for keys the store does
 * not hold yet; they are written in small transactions of their own, ahead of
 * the metadata. That is safe because a key is never rewritten: the record that
 * is still committed cannot point at any of them, and a save that fails later
 * only leaves unreferenced blobs for the next prune.
 *
 * Dual write for the previous release (remove one release after this one,
 * together with the protection of legacy keys in pruneCanvasAssetBlobs): that
 * release looks binaries up only by item id (<storeKey>::canvas::<itemId>, and
 * <itemId>::tex::<name> for model textures). Every slot therefore also gets
 * that per-item blob, copied once from its keyed blob when it is missing or
 * holds other bytes (`legacyWrites`, done by commitCanvasMetadata together
 * with the record); a later save of the unchanged slot moves nothing.
 */
async function storeCanvasAssetBlobs(
  db: IDBDatabase,
  storeKey: string,
  slots: readonly CanvasBlobStoreSlot[],
  baseline: CanvasSaveBaseline | null,
  allowByteReads = true
): Promise<{
  assetKeyByLogicalKey: Map<string, string>
  /** Logical key -> content key whose bytes its per-item blob holds after this save. */
  legacyBlobAssetKeys: Map<string, string>
  /** Per-item blobs to copy from their keyed blob in the commit. */
  legacyWrites: CanvasLegacyBlobWrite[]
  missingLogicalKeys: string[]
  /** Only with `allowByteReads` false: a slot needs its bytes read, nothing was written. */
  needsBytes: boolean
  /** Bytes read during this save, by logical key, for the mirror that follows. */
  readEntries: ResolvedCanvasBinaryAsset[]
}> {
  const existing = baseline?.index ?? null
  const previousLegacyBlobAssetKeys = baseline?.legacyBlobAssetKeys ?? new Map<string, string>()
  const assetKeyByLogicalKey = new Map<string, string>()
  const legacyBlobAssetKeys = new Map<string, string>()
  const missingLogicalKeys: string[] = []
  const readEntries: ResolvedCanvasBinaryAsset[] = []
  const storedKeys = new Set(existing?.assetKeys ?? [])
  let needsBytes = false
  const pendingByAssetKey = new Map<string, Promise<boolean>>()
  const legacyWrites: CanvasLegacyBlobWrite[] = []

  let batch: CanvasAssetBlobWrite[] = []
  let batchBytes = 0
  let flushChain: Promise<void> = Promise.resolve()
  const flush = (): Promise<void> => {
    const current = batch
    batch = []
    batchBytes = 0
    flushChain = flushChain.then(() => writeCanvasAssetBlobBatch(db, storeKey, current))
    return flushChain
  }
  const enqueue = async (entry: CanvasAssetBlobWrite): Promise<void> => {
    batch.push(entry)
    batchBytes += entry.data.byteLength
    if (batch.length >= CANVAS_BLOB_BATCH_MAX_ENTRIES || batchBytes >= CANVAS_BLOB_BATCH_MAX_BYTES) {
      await flush()
    }
  }
  /** Does the per-item blob of this slot already hold the bytes of `assetKey`? */
  const legacyBlobHolds = (slot: CanvasBlobStoreSlot, assetKey: string): boolean => {
    if (!existing?.legacyKeys.has(slot.logicalKey)) return false
    const recorded = previousLegacyBlobAssetKeys.get(slot.logicalKey)
    if (recorded !== undefined) return recorded === assetKey
    // A slot restored from that very blob in this session (a board of an earlier version).
    return (
      !getCanvasAssetSlotSourceFile(slot.owner, slot.slotId) &&
      canvasLegacyBlobByObjectUrl.get(slot.src) === getCanvasLegacyBlobId(storeKey, slot.logicalKey)
    )
  }

  const storeSlot = async (slot: CanvasBlobStoreSlot): Promise<void> => {
    let bytes: ResolvedCanvasBinaryAsset | null | undefined
    const readBytes = async (): Promise<ArrayBuffer | null> => {
      if (!allowByteReads) {
        needsBytes = true
        return null
      }
      if (bytes === undefined) {
        bytes = await readCanvasBlobStoreSlotBytes(slot, storeKey)
        if (bytes) readEntries.push(bytes)
      }
      return bytes ? bytes.data : null
    }

    let assetKey = await resolveCanvasAssetKey(slot.owner, slot.slotId, slot.src, readBytes)
    if (!assetKey) {
      // The source can no longer be read (a file that was moved or deleted). If this
      // canvas already stores the bytes last saved for that very source, keep using
      // them instead of refusing every further save of the board.
      const lastKnownKey = canvasAssetKeyHintBySource.get(slot.src)
      if (lastKnownKey && storedKeys.has(lastKnownKey)) assetKey = lastKnownKey
    }
    if (!assetKey) {
      missingLogicalKeys.push(slot.logicalKey)
      return
    }
    if (!storedKeys.has(assetKey)) {
      let pending = pendingByAssetKey.get(assetKey)
      if (!pending) {
        const key = assetKey
        pending = (async () => {
          const data = await readBytes()
          if (!data || !bytes) return false
          await enqueue({ assetKey: key, data, mimeType: bytes.mimeType })
          return true
        })()
        pendingByAssetKey.set(assetKey, pending)
      }
      if (!(await pending)) {
        missingLogicalKeys.push(slot.logicalKey)
        return
      }
    }
    assetKeyByLogicalKey.set(slot.logicalKey, assetKey)

    if (!legacyBlobHolds(slot, assetKey)) {
      if (!allowByteReads) {
        needsBytes = true
        return
      }
      legacyWrites.push({ logicalKey: slot.logicalKey, assetKey })
    }
    legacyBlobAssetKeys.set(slot.logicalKey, assetKey)
  }

  // Slots that share one object URL wait for the first of them: its key is then known
  // and the bytes are read once, however many copies of the item the board holds.
  const firstBySharedSource = new Map<string, Promise<void>>()
  const storeSlotOnce = async (slot: CanvasBlobStoreSlot): Promise<void> => {
    if (
      slot.src.startsWith('blob:') &&
      !getCanvasAssetSlotSourceFile(slot.owner, slot.slotId)
    ) {
      const first = firstBySharedSource.get(slot.src)
      if (!first) {
        const started = storeSlot(slot)
        firstBySharedSource.set(slot.src, started)
        return started
      }
      await first.catch(() => undefined)
    }
    return storeSlot(slot)
  }

  let nextSlot = 0
  const workers = Array.from(
    { length: Math.min(CANVAS_BLOB_WRITE_CONCURRENCY, slots.length) },
    async () => {
      while (nextSlot < slots.length) {
        const slot = slots[nextSlot]
        nextSlot += 1
        await storeSlotOnce(slot)
      }
    }
  )
  await Promise.all(workers)

  await flush()
  // Per-item blobs of items that are not saved now (deleted, still in the undo
  // history) keep their entry while the blob exists, so an undo moves nothing.
  for (const [logicalKey, assetKey] of previousLegacyBlobAssetKeys) {
    if (!legacyBlobAssetKeys.has(logicalKey) && existing?.legacyKeys.has(logicalKey)) {
      legacyBlobAssetKeys.set(logicalKey, assetKey)
    }
  }
  return {
    assetKeyByLogicalKey,
    legacyBlobAssetKeys,
    legacyWrites,
    missingLogicalKeys,
    readEntries,
    needsBytes
  }
}

/**
 * Commits the metadata record. Inside the same transaction it re-checks that
 * every content key the record points at is still stored (another window may
 * have pruned it since this save looked); if one is gone nothing is written
 * and the caller stores the bytes again. Resolves false in that case.
 * The per-item blobs of the previous release (`legacyWrites`) are copied from
 * their keyed blobs in this transaction too, so a per-item blob never holds
 * bytes the committed record does not name.
 */
async function commitCanvasMetadata(
  db: IDBDatabase,
  storeKey: string,
  payload: CanvasPersistedData,
  requiredAssetKeys: ReadonlySet<string>,
  verifyAssetKeys: boolean,
  legacyWrites: readonly CanvasLegacyBlobWrite[] = []
): Promise<boolean> {
  return await new Promise<boolean>((resolve, reject) => {
    const tx = db.transaction([BLOB_STORE_NAME, STORE_NAME], 'readwrite')
    let assetKeyVanished = false
    tx.oncomplete = () => {
      if (!assetKeyVanished) {
        for (const write of legacyWrites) noteCanvasLegacyBlobRewritten(storeKey, write.logicalKey)
      }
      resolve(!assetKeyVanished)
    }
    tx.onabort = () => {
      if (assetKeyVanished) resolve(false)
      else rejectCanvasStorageError(reject, 'canvas snapshot save transaction', tx.error)
    }
    tx.onerror = () => {
      if (assetKeyVanished) resolve(false)
      else rejectCanvasStorageError(reject, 'canvas snapshot save transaction', tx.error)
    }
    const fail = (error: unknown): void => {
      try { tx.abort() } catch { /* Already inactive. */ }
      rejectCanvasStorageError(reject, 'canvas snapshot save transaction', error)
    }
    const vanish = (): void => {
      if (assetKeyVanished) return
      assetKeyVanished = true
      try { tx.abort() } catch { /* Completes without the metadata write. */ }
    }
    try {
      const blobStore = tx.objectStore(BLOB_STORE_NAME)
      const putMetadata = (): void => {
        // The previous release reads these per-item blobs (remove one release after this one).
        // Each keyed blob is read once; the puts are issued from its request callback,
        // while the transaction is still active.
        const logicalKeysByAssetKey = new Map<string, string[]>()
        for (const write of legacyWrites) {
          const logicalKeys = logicalKeysByAssetKey.get(write.assetKey)
          if (logicalKeys) logicalKeys.push(write.logicalKey)
          else logicalKeysByAssetKey.set(write.assetKey, [write.logicalKey])
        }
        for (const [assetKey, logicalKeys] of logicalKeysByAssetKey) {
          const request = blobStore.get(getScopedCanvasAssetBlobKey(storeKey, assetKey))
          request.onsuccess = () => {
            try {
              const binary = request.result as CanvasStoredBinary | undefined
              if (!binary) {
                vanish()
                return
              }
              for (const logicalKey of logicalKeys) {
                blobStore.put(
                  { data: binary.data, mimeType: binary.mimeType },
                  getScopedCanvasBlobKey(storeKey, logicalKey)
                )
              }
            } catch (error) {
              fail(error)
            }
          }
          // Request errors abort the transaction; do not prevent their default action.
        }
        tx.objectStore(STORE_NAME).put(payload, storeKey)
      }
      if (!verifyAssetKeys || requiredAssetKeys.size === 0) {
        putMetadata()
        return
      }
      listCanvasBlobKeys(blobStore, storeKey, (index) => {
        try {
          if (index) {
            for (const assetKey of requiredAssetKeys) {
              if (index.assetKeys.has(assetKey)) continue
              vanish()
              return
            }
          }
          putMetadata()
        } catch (error) {
          fail(error)
        }
      })
    } catch (error) {
      fail(error)
    }
  })
}

/**
 * How many times each content key is referenced by a persisted item list
 * (items sharing one asset count once each). A key that is absent here and
 * not protected by the caller is unreferenced and may be deleted.
 */
export function countCanvasAssetKeyReferences(items: readonly unknown[]): Map<string, number> {
  const counts = new Map<string, number>()
  const add = (key: string): void => {
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    const keys = readPersistedCanvasAssetKeys(item)
    if (keys.assetKey) add(keys.assetKey)
    for (const key of Object.values(keys.textureAssetKeys)) add(key)
  }
  return counts
}

export type SaveCanvasItemsOptions = {
  /**
   * In-memory item lists that can still bring an asset back (the undo history
   * and the redo stack). Their assets are kept even though the saved items no
   * longer reference them.
   */
  getProtectedItems?: () => Iterable<readonly CanvasItem[]>
  /**
   * Save only if no asset byte has to be read or written, neither for
   * IndexedDB nor for the mirror. Otherwise nothing at all is written and the
   * save resolves with 'needs-bytes'.
   */
  metadataOnly?: boolean
}

/** `undefined`: saved. 'needs-bytes': a metadata-only save was asked for and was not possible. */
export type CanvasSaveOutcome = void | 'needs-bytes'

/** Content keys of in-memory items this session knows, without reading anything. */
function collectKnownCanvasAssetKeys(
  itemLists: Iterable<readonly CanvasItem[]>,
  target: Set<string>,
  itemIds?: Set<string>
): void {
  for (const list of itemLists) {
    for (const item of list) {
      itemIds?.add(item.id)
      if (!isBlobPersistableCanvasItem(item)) continue
      const blobItem = item as BlobPersistableCanvasItem
      if (blobItem.src) {
        const key = peekCanvasAssetKey(blobItem, CANVAS_ASSET_SOURCE_SLOT, blobItem.src)
        if (key) target.add(key)
        const hint = canvasAssetKeyHintBySource.get(blobItem.src)
        if (hint) target.add(hint)
        const bySourceString = canvasAssetKeyByShortSource.get(blobItem.src)
        if (bySourceString) target.add(bySourceString)
      }
      if (blobItem.type === 'model3d' && blobItem.textures) {
        for (const [textureName, textureUrl] of Object.entries(blobItem.textures)) {
          const key = peekCanvasAssetKey(
            blobItem,
            getCanvasTextureAssetSlot(textureName),
            textureUrl
          )
          if (key) target.add(key)
        }
      }
    }
  }
}

/** The item id a per-item blob key belongs to (an item id or `<itemId>::tex::<name>`). */
function getLegacyCanvasBlobItemId(logicalKey: string): string {
  const textureSeparator = logicalKey.indexOf('::tex::')
  return textureSeparator === -1 ? logicalKey : logicalKey.slice(0, textureSeparator)
}

/**
 * Deletes the blobs of one canvas that nothing can need any more. The
 * referenced set is read from the committed record inside the same
 * transaction, so a blob the stored canvas needs can never be removed; keys of
 * `protectedAssetKeys` (the items just saved, undo history, redo stack) are
 * kept as well. Per-item blobs (the previous release's keys) are kept for every
 * item of the committed record and every item of `protectedItemIds`; only the
 * blobs of items that are in neither are swept. Without a committed record, or
 * where the store cannot be enumerated, nothing is deleted.
 */
async function pruneCanvasAssetBlobs(
  db: IDBDatabase,
  storeKey: string,
  protectedAssetKeys: ReadonlySet<string>,
  protectedItemIds: ReadonlySet<string>
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([STORE_NAME, BLOB_STORE_NAME], 'readwrite')
    tx.oncomplete = () => resolve()
    tx.onabort = () => rejectCanvasStorageError(reject, 'canvas asset prune transaction', tx.error)
    tx.onerror = () => rejectCanvasStorageError(reject, 'canvas asset prune transaction', tx.error)
    try {
      const itemStore = tx.objectStore(STORE_NAME)
      const blobStore = tx.objectStore(BLOB_STORE_NAME)
      if (
        typeof (itemStore as Partial<IDBObjectStore>).get !== 'function' ||
        typeof (blobStore as Partial<IDBObjectStore>).delete !== 'function'
      ) {
        return
      }
      const request = itemStore.get(storeKey)
      request.onsuccess = () => {
        const persisted = request.result as
          | CanvasPersistedData
          | SerializableCanvasItem[]
          | undefined
        if (persisted === undefined) return
        const persistedItems = extractPersistedCanvasData(persisted).items
        const referenced = countCanvasAssetKeyReferences(persistedItems)
        const liveItemIds = new Set(protectedItemIds)
        for (const item of persistedItems) {
          if (item && typeof item === 'object' && typeof item.id === 'string') liveItemIds.add(item.id)
        }
        listCanvasBlobKeys(blobStore, storeKey, (index) => {
          if (!index) return
          for (const assetKey of index.assetKeys) {
            if (referenced.has(assetKey) || protectedAssetKeys.has(assetKey)) continue
            blobStore.delete(getScopedCanvasAssetBlobKey(storeKey, assetKey))
          }
          // The previous release reads these (remove one release after this one).
          for (const legacyKey of index.legacyKeys) {
            if (legacyKey.startsWith(CANVAS_ASSET_BLOB_KEY_PREFIX)) continue
            if (liveItemIds.has(getLegacyCanvasBlobItemId(legacyKey))) continue
            blobStore.delete(getScopedCanvasBlobKey(storeKey, legacyKey))
          }
        })
      }
    } catch (error) {
      try { tx.abort() } catch { /* Already inactive. */ }
      rejectCanvasStorageError(reject, 'canvas asset prune transaction', error)
    }
  })
}

// ─── Autosave mirror ─────────────────────────────────────────────────────────
// The mirror is a second copy of the board outside IndexedDB:
// <autoSaveRoot>/<project>/project.mpcanvas plus assets/<content key><ext>.
// An asset file is written once and never rewritten, so the project file that
// is on disk always points at complete files; a save writes only the assets
// the folder does not hold yet, then the project file, and only then removes
// what nothing references any more.
const CANVAS_MIRROR_STAGE_CONCURRENCY = 3
const CANVAS_MIRROR_ASSET_FILE_NAME_PATTERN = /^[bfu]-[0-9a-f]{40}(?:\.[a-z0-9]{1,16})?$/
const CANVAS_SOURCE_STRING_KEY_CACHE_MAX_LENGTH = 2048

// Keys of sources identified by their string (remote URLs, data: URLs); only
// short strings are remembered so that no large data: URL is kept alive here.
const canvasAssetKeyByShortSource = new Map<string, string>()
// Asset files written in this session, per mirror folder, for bridges that cannot list a folder.
const canvasMirrorWrittenAssetsByDir = new Map<string, Set<string>>()

type CanvasMirrorSlot = {
  owner: BlobPersistableCanvasItem
  slotId: string
  /** Item id or model texture key. */
  logicalKey: string
  src: string
  fileName: string
  fallbackMimeType: string
}

type CanvasMirrorSlotPlan = {
  slot: CanvasMirrorSlot
  /** File name under assets/, or null when the slot cannot be mirrored. */
  assetFileName: string | null
  /** Set once the file is known to be in the mirror folder. */
  staged: boolean
}

type CanvasMirrorTransport = {
  /** Asset file names in the folder. */
  list(): Promise<Set<string>>
  /** File-to-file copy in the main process; null when the bridge has no such call. */
  copy: ((assetFileName: string, sourcePath: string) => Promise<boolean>) | null
  write(assetFileName: string, data: ArrayBuffer): Promise<void>
  prune: ((keepAssetKeys: string[], keepEntryNames: string[]) => Promise<void>) | null
}

type CanvasMirrorPlan = {
  projectDir: string
  assetDir: string
  transport: CanvasMirrorTransport
  slotPlans: CanvasMirrorSlotPlan[]
  /** Asset files the folder does not hold yet, each with one slot that can provide the bytes. */
  missing: Map<string, CanvasMirrorSlotPlan>
  /** True when the save has to read or move asset bytes. */
  needsBytes: boolean
  /** Bytes read while planning (to compute a content key), by logical key. */
  bytesByLogicalKey: Map<string, ResolvedCanvasBinaryAsset>
}

function collectCanvasMirrorSlots(items: readonly CanvasItem[]): CanvasMirrorSlot[] {
  const slots: CanvasMirrorSlot[] = []
  for (const item of items) {
    if (!isBlobPersistableCanvasItem(item)) continue
    const blobItem = item as BlobPersistableCanvasItem
    if (blobItem.src) {
      const fileName = resolveCanvasAssetFileName(blobItem)
      slots.push({
        owner: blobItem,
        slotId: CANVAS_ASSET_SOURCE_SLOT,
        logicalKey: blobItem.id,
        src: blobItem.src,
        fileName,
        fallbackMimeType: guessMimeType(fileName)
      })
    }
    if (blobItem.type === 'model3d' && blobItem.textures) {
      for (const [textureName, textureUrl] of Object.entries(blobItem.textures)) {
        if (!textureUrl) continue
        slots.push({
          owner: blobItem,
          slotId: getCanvasTextureAssetSlot(textureName),
          logicalKey: getModelTextureKey(blobItem.id, textureName),
          src: textureUrl,
          fileName: textureName,
          fallbackMimeType: guessTextureMimeType(textureName)
        })
      }
    }
  }
  return slots
}

function getCanvasMirrorAssetExtension(fileName: string): string {
  const match = /\.([A-Za-z0-9]{1,16})$/.exec(fileName.trim())
  return match ? `.${match[1].toLowerCase()}` : ''
}

/** Key of a source that is identified by its string: a remote URL or a data: URL. */
async function resolveCanvasSourceStringAssetKey(
  owner: object,
  slotId: string,
  src: string
): Promise<string> {
  // Long data: URLs are not kept in the string cache; the slot cache saves hashing them on every save.
  const cachedSlot = canvasAssetKeyBySlot.get(owner)?.get(slotId)
  if (
    cachedSlot &&
    cachedSlot.src === src &&
    cachedSlot.sourceFile === getCanvasAssetSlotSourceFile(owner, slotId)
  ) {
    return cachedSlot.key
  }
  const cacheable = src.length <= CANVAS_SOURCE_STRING_KEY_CACHE_MAX_LENGTH
  let key = cacheable ? canvasAssetKeyByShortSource.get(src) : undefined
  if (!key) {
    const digest = await sha256Hex(new TextEncoder().encode(`canvas-asset-source-v1\n${src}`))
    key = `u-${digest.slice(0, CANVAS_ASSET_KEY_HEX_LENGTH)}`
    if (cacheable) rememberBoundedCanvasAssetKey(canvasAssetKeyByShortSource, src, key)
  }
  let slots = canvasAssetKeyBySlot.get(owner)
  if (!slots) {
    slots = new Map()
    canvasAssetKeyBySlot.set(owner, slots)
  }
  slots.set(slotId, { src, sourceFile: getCanvasAssetSlotSourceFile(owner, slotId), key })
  return key
}

async function readCanvasMirrorSlotBytes(
  slot: CanvasMirrorSlot,
  storeKey: string,
  assetKey: string | undefined
): Promise<ResolvedCanvasBinaryAsset | null> {
  const options: CanvasBinaryAssetResolveOptions = {
    allowIndexedDbFallback: true,
    indexedDbAssetKey: assetKey
  }
  return slot.slotId === CANVAS_ASSET_SOURCE_SLOT
    ? await resolveCanvasBinaryAssetForItem(
        slot.owner,
        slot.logicalKey,
        slot.src,
        slot.fileName,
        slot.fallbackMimeType,
        storeKey,
        options
      )
    : await resolveCanvasBinaryAsset(
        slot.logicalKey,
        slot.src,
        slot.fileName,
        slot.fallbackMimeType,
        storeKey,
        options
      )
}

/**
 * Where a source points inside the mirror's own asset folder: the name of the
 * entry directly under assets/ and whether the source is that entry itself.
 * Null for every source outside the folder.
 */
function getCanvasMirrorEntryForSource(
  assetDir: string,
  src: string
): { entryName: string; isTopLevelFile: boolean } | null {
  const localPath = resolveLocalFilePathFromSource(src)
  if (!localPath) return null
  // Compared without the leading separators: URLs written by earlier versions lost them.
  const trim = (value: string): string => value.replace(/[\\/]+/g, '/').replace(/^\/+|\/+$/g, '')
  const dir = trim(assetDir)
  const file = trim(localPath)
  if (!dir || !file.toLowerCase().startsWith(`${dir.toLowerCase()}/`)) return null
  const segments = file.slice(dir.length + 1).split('/')
  if (segments.length === 0 || segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    return null
  }
  return { entryName: segments[0], isTopLevelFile: segments.length === 1 }
}

function createCanvasMirrorTransport(
  projectDirName: string,
  assetDir: string
): CanvasMirrorTransport | null {
  const svcFs = window.api?.svcFs
  if (!svcFs) return null

  if (
    typeof svcFs.copyCanvasMirrorAsset === 'function' &&
    typeof svcFs.writeCanvasMirrorAsset === 'function' &&
    typeof svcFs.listCanvasMirrorAssets === 'function' &&
    typeof svcFs.pruneCanvasMirrorAssets === 'function'
  ) {
    return {
      list: async () =>
        new Set((await svcFs.listCanvasMirrorAssets({ projectDirName })).assetFileNames),
      copy: async (assetFileName, sourcePath) => {
        try {
          const receipt = await svcFs.copyCanvasMirrorAsset({
            projectDirName,
            assetFileName,
            sourcePath
          })
          return receipt?.status === 'written' || receipt?.status === 'exists'
        } catch {
          // Not authorized for a direct copy, or unreadable: the bytes go through the renderer.
          return false
        }
      },
      write: async (assetFileName, data) => {
        const receipt = await svcFs.writeCanvasMirrorAsset({
          projectDirName,
          assetFileName,
          data: new Uint8Array(data)
        })
        if (receipt?.status !== 'written' && receipt?.status !== 'exists') {
          throw new Error('CANVAS_PROJECT_ASSET_WRITE_UNACKNOWLEDGED')
        }
      },
      prune: async (keepAssetKeys, keepEntryNames) => {
        await svcFs.pruneCanvasMirrorAssets({ projectDirName, keepAssetKeys, keepEntryNames })
      }
    }
  }

  // A bridge without the mirror calls: the same layout through the generic file calls.
  if (typeof svcFs.saveImageToPath !== 'function') return null
  let written = canvasMirrorWrittenAssetsByDir.get(assetDir)
  if (!written) {
    written = new Set()
    canvasMirrorWrittenAssetsByDir.set(assetDir, written)
  }
  const writtenInSession = written
  return {
    list: async () => {
      if (typeof svcFs.listFilesInFolder !== 'function') return new Set(writtenInSession)
      const { files } = await svcFs.listFilesInFolder({ folderPath: assetDir })
      const names = new Set<string>()
      for (const file of files) {
        const entry = getCanvasMirrorEntryForSource(assetDir, toLocalMediaUrl(file.fullPath))
        if (
          entry?.isTopLevelFile &&
          CANVAS_MIRROR_ASSET_FILE_NAME_PATTERN.test(entry.entryName)
        ) {
          names.add(entry.entryName)
        }
      }
      return names
    },
    copy: null,
    write: async (assetFileName, data) => {
      const receipt = await svcFs.saveImageToPath({
        image: new Uint8Array(data),
        outputPath: assetDir,
        filename: assetFileName
      })
      if (receipt?.success !== true) {
        throw new Error('CANVAS_PROJECT_ASSET_WRITE_UNACKNOWLEDGED')
      }
      writtenInSession.add(assetFileName)
    },
    prune: null
  }
}

/**
 * Works out which asset files the mirror needs for these items and which of
 * them are missing. With `allowByteReads` false nothing is read: a slot whose
 * key would need its bytes only marks the plan as needing bytes.
 * Returns null when there is no mirror in this environment.
 */
async function planCanvasMirrorSave(
  storeKey: string,
  items: readonly CanvasItem[],
  assetKeyByLogicalKey: ReadonlyMap<string, string>,
  allowByteReads: boolean
): Promise<CanvasMirrorPlan | null> {
  if (!window.api?.svcFs || !window.path || typeof window.path.join !== 'function') return null
  const autoSaveRoot = await resolveAutoSaveRootPath()
  if (!autoSaveRoot) return null
  const projectDirName = resolveProjectStorageDirName(storeKey)
  const projectDir = window.path.join(autoSaveRoot, projectDirName)
  const assetDir = window.path.join(projectDir, PROJECT_ASSET_DIRNAME)
  const transport = createCanvasMirrorTransport(projectDirName, assetDir)
  if (!transport) return null

  const slots = collectCanvasMirrorSlots(items)
  const existing = slots.length > 0 ? await transport.list() : new Set<string>()
  const plan: CanvasMirrorPlan = {
    projectDir,
    assetDir,
    transport,
    slotPlans: [],
    missing: new Map(),
    needsBytes: false,
    bytesByLogicalKey: new Map()
  }

  for (const slot of slots) {
    const slotPlan: CanvasMirrorSlotPlan = { slot, assetFileName: null, staged: false }
    plan.slotPlans.push(slotPlan)

    // A source that already is an asset file of this mirror is referenced where it is.
    const ownEntry = getCanvasMirrorEntryForSource(assetDir, slot.src)
    if (
      ownEntry?.isTopLevelFile &&
      CANVAS_MIRROR_ASSET_FILE_NAME_PATTERN.test(ownEntry.entryName) &&
      existing.has(ownEntry.entryName)
    ) {
      slotPlan.assetFileName = ownEntry.entryName
      slotPlan.staged = true
      continue
    }

    let assetKey: string | null = assetKeyByLogicalKey.get(slot.logicalKey) ?? null
    if (!assetKey) {
      const isLocalFile = resolveLocalFilePathFromSource(slot.src) !== null
      if (isLocalFile || slot.src.startsWith('blob:')) {
        assetKey = await resolveCanvasAssetKey(slot.owner, slot.slotId, slot.src, async () => {
          if (!allowByteReads) {
            plan.needsBytes = true
            return null
          }
          const bytes = await readCanvasMirrorSlotBytes(slot, storeKey, undefined)
          if (bytes) plan.bytesByLogicalKey.set(slot.logicalKey, bytes)
          return bytes ? bytes.data : null
        })
      } else {
        assetKey = await resolveCanvasSourceStringAssetKey(slot.owner, slot.slotId, slot.src)
      }
    }
    if (!assetKey) continue

    const assetFileName = `${assetKey}${getCanvasMirrorAssetExtension(slot.fileName)}`
    slotPlan.assetFileName = assetFileName
    if (existing.has(assetFileName)) {
      slotPlan.staged = true
    } else if (!plan.missing.has(assetFileName)) {
      plan.missing.set(assetFileName, slotPlan)
    }
  }

  if (plan.missing.size > 0) plan.needsBytes = true
  return plan
}

async function stageCanvasMirrorAsset(
  plan: CanvasMirrorPlan,
  slotPlan: CanvasMirrorSlotPlan,
  assetFileName: string,
  storeKey: string,
  seedEntries: ReadonlyMap<string, ResolvedCanvasBinaryAsset>
): Promise<boolean> {
  const { slot } = slotPlan
  const localPath = resolveLocalFilePathFromSource(slot.src)
  // A file the main process may read is copied there; its bytes never enter the renderer.
  if (
    localPath &&
    plan.transport.copy &&
    (!getCanvasAssetSlotSourceFile(slot.owner, slot.slotId) ||
      getMatchingLocalFileIdentity(slot.owner, slot.slotId, slot.src)) &&
    (await plan.transport.copy(assetFileName, localPath))
  ) {
    return true
  }

  const assetKey = assetFileName.split('.')[0]
  const bytes =
    seedEntries.get(slot.logicalKey) ??
    plan.bytesByLogicalKey.get(slot.logicalKey) ??
    (await readCanvasMirrorSlotBytes(slot, storeKey, assetKey))
  if (!bytes) {
    console.error('[Canvas Storage] Failed to stage project asset:', slot.logicalKey)
    return false
  }
  await plan.transport.write(assetFileName, bytes.data)
  return true
}

/**
 * The "assets/..." reference of every slot in the project file currently on
 * disk, by item id or model texture key (absolute references into the asset
 * folder are turned into that form). Null when the file cannot be read; an
 * empty map when there is none.
 */
async function readPreviousCanvasMirrorRefs(plan: CanvasMirrorPlan): Promise<Map<string, string> | null> {
  const refs = new Map<string, string>()
  const toRef = (value: unknown): string | null => {
    if (typeof value !== 'string' || !value) return null
    const normalized = value.replace(/[\\/]+/g, '/').replace(/^\.\//, '')
    if (normalized.startsWith(`${PROJECT_ASSET_DIRNAME}/`)) return normalized
    const entry = getCanvasMirrorEntryForSource(plan.assetDir, value)
    if (!entry) return null
    const localPath = resolveLocalFilePathFromSource(value)!
    const trimmed = localPath.replace(/[\\/]+/g, '/').replace(/^\/+|\/+$/g, '')
    const dir = plan.assetDir.replace(/[\\/]+/g, '/').replace(/^\/+|\/+$/g, '')
    return `${PROJECT_ASSET_DIRNAME}/${trimmed.slice(dir.length + 1)}`
  }
  let content: string
  try {
    content = (
      await window.api.svcFs.readTextFile({
        fullPath: window.path.join(plan.projectDir, AUTOSAVE_CANVAS_FILENAME)
      })
    ).content
  } catch (error) {
    return isMissingMirrorFileError(error) ? refs : null
  }
  try {
    const parsed = JSON.parse(content) as { items?: unknown }
    if (!Array.isArray(parsed?.items)) return null
    for (const item of parsed.items as Array<Record<string, unknown>>) {
      if (!item || typeof item !== 'object' || typeof item.id !== 'string') continue
      const sourceRef = toRef(item.src)
      if (sourceRef) refs.set(item.id, sourceRef)
      if (item.textures && typeof item.textures === 'object') {
        for (const [textureName, textureUrl] of Object.entries(item.textures as Record<string, unknown>)) {
          const textureRef = toRef(textureUrl)
          if (textureRef) refs.set(getModelTextureKey(item.id, textureName), textureRef)
        }
      }
    }
    return refs
  } catch {
    return null
  }
}

/** The entry directly under assets/ that an "assets/..." reference names. */
function getCanvasMirrorRefEntryName(ref: string): string | null {
  const segments = ref.split('/')
  if (
    segments.length < 2 ||
    segments[0] !== PROJECT_ASSET_DIRNAME ||
    segments.slice(1).some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    return null
  }
  return segments[1]
}

/**
 * Writes the missing asset files, then the project file that references them,
 * and after that write is acknowledged removes what is no longer referenced.
 * Returns false when the mirror could not be written; the previous project
 * file and everything it references are then still in place.
 */
async function executeCanvasMirrorSave(
  plan: CanvasMirrorPlan,
  storeKey: string,
  items: CanvasItem[],
  groups: CanvasGroup[],
  groupBranches: CanvasGroupBranch[],
  figmaBinding: CanvasFigmaBinding | null,
  seedEntries: ReadonlyMap<string, ResolvedCanvasBinaryAsset>,
  getProtectedItems: (() => Iterable<readonly CanvasItem[]>) | undefined
): Promise<boolean> {
  try {
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0))

    // 1. Asset files first; they are new names, nothing on disk points at them yet.
    const stagedFileNames = new Set<string>()
    const pending = [...plan.missing.entries()]
    let next = 0
    const workers = Array.from(
      { length: Math.min(CANVAS_MIRROR_STAGE_CONCURRENCY, pending.length) },
      async () => {
        while (next < pending.length) {
          const [assetFileName, slotPlan] = pending[next]
          next += 1
          if (await stageCanvasMirrorAsset(plan, slotPlan, assetFileName, storeKey, seedEntries)) {
            stagedFileNames.add(assetFileName)
          }
        }
      }
    )
    await Promise.all(workers)

    // 2. The project file. A slot whose asset could not be staged (its key cannot be
    // computed now, or its bytes cannot be read) is unsafe: the copy the previous
    // project file names for it may be the last one. It keeps that reference, and the
    // entry it names is kept; with no such reference it keeps its original source and
    // nothing is pruned in this save.
    const refBySlot = new Map<string, string>()
    const unsafeSlotPlans: CanvasMirrorSlotPlan[] = []
    for (const slotPlan of plan.slotPlans) {
      if (
        slotPlan.assetFileName &&
        (slotPlan.staged || stagedFileNames.has(slotPlan.assetFileName))
      ) {
        refBySlot.set(
          slotPlan.slot.logicalKey,
          `${PROJECT_ASSET_DIRNAME}/${slotPlan.assetFileName}`
        )
      } else {
        unsafeSlotPlans.push(slotPlan)
      }
    }
    const carriedEntryNames = new Set<string>()
    let pruneIsSafe = true
    if (unsafeSlotPlans.length > 0) {
      const previousRefs = await readPreviousCanvasMirrorRefs(plan)
      for (const slotPlan of unsafeSlotPlans) {
        const previousRef = previousRefs?.get(slotPlan.slot.logicalKey)
        const entryName = previousRef ? getCanvasMirrorRefEntryName(previousRef) : null
        if (previousRef && entryName) {
          refBySlot.set(slotPlan.slot.logicalKey, previousRef)
          carriedEntryNames.add(entryName)
        } else {
          pruneIsSafe = false
        }
      }
    }
    const projectItems = serializeItems(items).map((serializedItem) => {
      if (!isBlobPersistableCanvasItem(serializedItem)) return serializedItem
      let nextItem = serializedItem as SerializableBlobPersistableCanvasItem
      const sourceRef = serializedItem.src ? refBySlot.get(serializedItem.id) : undefined
      if (sourceRef) nextItem = { ...nextItem, src: sourceRef }
      if (serializedItem.type === 'model3d' && serializedItem.textures) {
        const nextTextures: Record<string, string> = {}
        for (const [textureName, textureUrl] of Object.entries(serializedItem.textures)) {
          nextTextures[textureName] =
            refBySlot.get(getModelTextureKey(serializedItem.id, textureName)) ?? textureUrl
        }
        nextItem = { ...nextItem, textures: nextTextures }
      }
      return nextItem as SerializableCanvasItem
    })
    const canvasFileData: CanvasFileData = {
      magic: CANVAS_FILE_MAGIC,
      version: CANVAS_FILE_VERSION,
      createdAt: new Date().toISOString(),
      storageMode: 'project',
      items: projectItems,
      groups,
      groupBranches,
      figmaBinding
    }
    const svcFs = window.api.svcFs
    const receipt = await svcFs.writeTextFile({
      outputPath: plan.projectDir,
      filename: AUTOSAVE_CANVAS_FILENAME,
      content: JSON.stringify(canvasFileData)
    })
    if (receipt?.success !== true) {
      throw new Error('CANVAS_PROJECT_METADATA_WRITE_UNACKNOWLEDGED')
    }
    if (typeof svcFs.pruneAutoSaveProjects === 'function') {
      void svcFs.pruneAutoSaveProjects({
        currentProjectDirName: resolveProjectStorageDirName(storeKey),
        maxProjects: AUTOSAVE_PROJECT_LIMIT
      })
    }

    // 3. Cleanup, only now. Main keeps whatever the project file on disk references;
    // on top of that: everything the saved, live, undo and redo items can still need.
    if (plan.transport.prune && pruneIsSafe) {
      try {
        const keepAssetKeys = new Set<string>()
        const keepEntryNames = new Set<string>(carriedEntryNames)
        for (const fileName of refBySlot.values()) {
          keepAssetKeys.add(fileName.slice(PROJECT_ASSET_DIRNAME.length + 1).split('.')[0])
        }
        const protectedLists: Array<readonly CanvasItem[]> = [items, ...(getProtectedItems?.() ?? [])]
        collectKnownCanvasAssetKeys(protectedLists, keepAssetKeys)
        for (const list of protectedLists) {
          for (const slot of collectCanvasMirrorSlots(list)) {
            const ownEntry = getCanvasMirrorEntryForSource(plan.assetDir, slot.src)
            if (ownEntry) keepEntryNames.add(ownEntry.entryName)
          }
        }
        await plan.transport.prune(
          [...keepAssetKeys].filter((key) => isCanvasAssetKey(key)),
          [...keepEntryNames]
        )
      } catch (error) {
        console.warn('[Canvas Storage] Failed to prune unreferenced autosave assets:', error)
      }
    }
    return true
  } catch (error) {
    console.warn('[Canvas Storage] Failed to write autosave:', error)
    return false
  }
}

// Saves, clears and prunes of one canvas run one after another: a prune must
// never interleave with the asset writes of a save that is still in flight.
const canvasStoreOperationTails = new Map<string, Promise<unknown>>()

function runExclusiveCanvasStoreOperation<T>(
  storeKey: string,
  operation: () => Promise<T>
): Promise<T> {
  const previous = canvasStoreOperationTails.get(storeKey)
  const result = previous ? previous.then(operation, operation) : operation()
  const tail = result.then(
    () => undefined,
    () => undefined
  )
  canvasStoreOperationTails.set(storeKey, tail)
  void tail.then(() => {
    if (canvasStoreOperationTails.get(storeKey) === tail) {
      canvasStoreOperationTails.delete(storeKey)
    }
  })
  return result
}

const CANVAS_SAVE_MAX_ATTEMPTS = 2

/**
 * Persist canvas items to IndexedDB.
 * Drop non-serializable fields such as HTMLImageElement.
 * Binary data of blob-backed image, model, video, and file items is stored once
 * under its content key; a save only moves the bytes of assets it has not stored yet.
 */
export function saveCanvasItems(
  items: CanvasItem[],
  storeKey: string = KEY,
  groups: CanvasGroup[] = [],
  groupBranches: CanvasGroupBranch[] = [],
  figmaBinding: CanvasFigmaBinding | null = null,
  options: SaveCanvasItemsOptions = {}
): Promise<CanvasSaveOutcome> {
  return runExclusiveCanvasStoreOperation(storeKey, () =>
    saveCanvasItemsExclusive(items, storeKey, groups, groupBranches, figmaBinding, options)
  )
}

async function saveCanvasItemsExclusive(
  items: CanvasItem[],
  storeKey: string,
  groups: CanvasGroup[],
  groupBranches: CanvasGroupBranch[],
  figmaBinding: CanvasFigmaBinding | null,
  options: SaveCanvasItemsOptions
): Promise<CanvasSaveOutcome> {
  const metadataOnly = options.metadataOnly === true
  let db: IDBDatabase | undefined
  try {
    db = await openDB()

    // 1. Store the bytes of every asset this canvas does not hold yet.
    const slots = collectCanvasBlobStoreSlots(items)
    let assetKeyByLogicalKey = new Map<string, string>()
    let readEntries: ResolvedCanvasBinaryAsset[] = []
    let mirrorPlan: CanvasMirrorPlan | null | undefined
    for (let attempt = 1; ; attempt += 1) {
      const baseline = slots.length > 0 ? await readCanvasSaveBaseline(db, storeKey) : null
      const existing = baseline?.index ?? null
      const stored = await storeCanvasAssetBlobs(db, storeKey, slots, baseline, !metadataOnly)
      if (stored.needsBytes) return 'needs-bytes'
      if (stored.missingLogicalKeys.length > 0) {
        throw new Error(
          `[Canvas Storage] Refusing to save canvas metadata because binary data could not be persisted: ${stored.missingLogicalKeys.join(', ')}`
        )
      }
      assetKeyByLogicalKey = stored.assetKeyByLogicalKey
      readEntries = stored.readEntries

      if (metadataOnly && mirrorPlan === undefined) {
        // Decided before anything is written: the mirror must not need bytes either.
        try {
          mirrorPlan = await planCanvasMirrorSave(storeKey, items, assetKeyByLogicalKey, false)
        } catch {
          return 'needs-bytes'
        }
        if (mirrorPlan?.needsBytes) return 'needs-bytes'
      }

      // 2. Commit the metadata; it names each stored binary by its content key.
      const persistedItems = serializeItems(items).map((item) => {
        if (!isBlobPersistableCanvasItem(item)) return item
        let persistedItem = item as SerializableCanvasItem
        if (item.type === 'model3d' && item.textures) {
          const textureAssetKeys: Record<string, string> = {}
          for (const textureName of Object.keys(item.textures)) {
            const assetKey = assetKeyByLogicalKey.get(getModelTextureKey(item.id, textureName))
            if (assetKey) textureAssetKeys[textureName] = assetKey
          }
          if (Object.keys(textureAssetKeys).length > 0) {
            persistedItem = { ...persistedItem, textureAssetKeys } as unknown as SerializableCanvasItem
          }
        }
        const assetKey = assetKeyByLogicalKey.get(item.id)
        return assetKey
          ? ({ ...persistedItem, src: '', assetKey } as unknown as SerializableCanvasItem)
          : persistedItem
      })
      const payload: CanvasPersistedData = {
        items: persistedItems,
        groups,
        groupBranches,
        figmaBinding,
        assetFormat: CANVAS_RECORD_ASSET_FORMAT,
        legacyBlobAssetKeys: Object.fromEntries(stored.legacyBlobAssetKeys)
      }
      const committed = await commitCanvasMetadata(
        db,
        storeKey,
        payload,
        new Set(assetKeyByLogicalKey.values()),
        existing !== null,
        stored.legacyWrites
      )
      if (committed) break
      if (attempt >= CANVAS_SAVE_MAX_ATTEMPTS) {
        throw new Error(
          '[Canvas Storage] Refusing to save canvas metadata because stored binary data disappeared during the save.'
        )
      }
    }

    // 3. The mirror: missing asset files, the project file, then its own cleanup.
    // Its failure does not fail the save; IndexedDB already holds the board.
    try {
      if (mirrorPlan === undefined) {
        mirrorPlan = await planCanvasMirrorSave(storeKey, items, assetKeyByLogicalKey, true)
      }
      if (mirrorPlan) {
        await executeCanvasMirrorSave(
          mirrorPlan,
          storeKey,
          items,
          groups,
          groupBranches,
          figmaBinding,
          new Map(readEntries.map((entry) => [entry.key, entry])),
          options.getProtectedItems
        )
      }
    } catch (error) {
      console.warn('[Canvas Storage] Failed to write autosave:', error)
    }

    // 4. Drop the blobs nothing references any more. Best effort: a failure here
    // only delays the cleanup to a later save.
    try {
      const protectedAssetKeys = new Set(assetKeyByLogicalKey.values())
      const protectedItemIds = new Set(items.map((item) => item.id))
      collectKnownCanvasAssetKeys(
        options.getProtectedItems?.() ?? [],
        protectedAssetKeys,
        protectedItemIds
      )
      await pruneCanvasAssetBlobs(db, storeKey, protectedAssetKeys, protectedItemIds)
    } catch (error) {
      console.warn('[Canvas Storage] Failed to prune unreferenced canvas assets:', error)
    }
    return undefined
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
    const { persisted, binaries, resolvedByAssetKey, resolvedByLegacyBlob } =
      await readIndexedDbCanvasSnapshot(db, storeKey)
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
    const restoredBlobUrls = createdUrls
    const restoredItems = restorePersistedCanvasItems(resolvedIndexedDbItems, restoredBlobUrls).map(
      (item) => tagRestoredCanvasItemAssetKeys(item, restoredBlobUrls, resolvedByAssetKey)
    )

    if (restoredItems.length === 0 && resolvedIndexedDbItems.length > 0) {
      for (const url of createdUrls.values()) URL.revokeObjectURL(url)
      createdUrls = undefined
      const projectSnapshot = await loadCanvasFallback(storeKey)
      return projectSnapshot ?? { items: [], groups, groupBranches, figmaBinding }
    }
    for (const logicalKey of resolvedByLegacyBlob) {
      const url = restoredBlobUrls.get(logicalKey)
      if (url) rememberCanvasLegacyBlobObjectUrl(url, storeKey, logicalKey)
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
export function clearCanvasItems(storeKey: string = KEY): Promise<void> {
  return runExclusiveCanvasStoreOperation(storeKey, () => clearCanvasItemsExclusive(storeKey))
}

async function clearCanvasItemsExclusive(storeKey: string): Promise<void> {
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

    const mirrorPlan = await planCanvasMirrorSave(storeKey, [], new Map(), true)
    if (mirrorPlan) {
      // Nothing is pruned here: the cleared items are still in the undo history.
      await executeCanvasMirrorSave(
        { ...mirrorPlan, transport: { ...mirrorPlan.transport, prune: null } },
        storeKey,
        [],
        [],
        [],
        null,
        new Map(),
        undefined
      )
    }
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
          {
            allowIndexedDbFallback: true,
            indexedDbAssetKey:
              peekCanvasAssetKey(item, CANVAS_ASSET_SOURCE_SLOT, item.src) ?? undefined
          }
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
            {
              allowIndexedDbFallback: true,
              indexedDbAssetKey:
                peekCanvasAssetKey(item, getCanvasTextureAssetSlot(textureName), textureUrl) ??
                undefined
            }
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
