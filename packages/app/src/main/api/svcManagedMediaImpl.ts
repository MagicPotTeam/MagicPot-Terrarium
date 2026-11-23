import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type {
  EnsureManagedMediaDerivativeReq,
  EnsureManagedMediaDerivativeResp,
  ImportManagedMediaBytesReq,
  ImportManagedMediaDataUrlReq,
  ImportManagedMediaFileReq,
  ImportManagedMediaResp,
  MigrateLegacyManagedMediaReq,
  MigrateLegacyManagedMediaResp,
  ReclaimLegacyManagedMediaReq,
  ReclaimLegacyManagedMediaResp,
  UpdateManagedMediaReferenceSnapshotReq,
  UpdateManagedMediaReferenceSnapshotResp,
  ManagedMediaDerivativeDescriptor,
  ManagedMediaSvc,
  ManagedMediaStorage,
  MaterializeManagedMediaForRequestReq,
  MaterializeManagedMediaForRequestResp
} from '@shared/api/svcManagedMedia'
import {
  MANAGED_MEDIA_IMPORT_BYTES_MAX_BYTES,
  WINDOWS_DEVICE_NAME,
  validateEnsureManagedMediaDerivativeResp,
  validateImportManagedMediaResp,
  validateMigrateLegacyManagedMediaResp,
  validateMaterializeManagedMediaForRequestReq,
  validateMaterializeManagedMediaForRequestResp
} from '@shared/api/svcManagedMedia'
import { ServiceError } from '@shared/api/apiUtils/serviceValidation'
import { normalizeMediaReference } from '@shared/mediaReference'
import { createBinaryChunkTransport } from '@shared/binaryChunkProtocol'
import { getChatMediaDir, getChatMediaNamespaceDir } from '../llmProxy/chatMediaDir'
import { migrateLegacyBase64MediaOnDemand } from '../llmProxy/legacyBase64MediaMigration'
import {
  ensureManagedMediaDerivative,
  type EnsureManagedMediaDerivativeResult
} from '../llmProxy/managedMediaDerivatives'
import {
  ManagedMediaImportError,
  ManagedMediaResolutionError,
  importManagedMedia,
  importManagedMediaFile,
  isManagedMediaMimeTypeSupported,
  type ImportSourceGuard,
  readManagedMediaBytes,
  isPathInsideRoot,
  type ImportedManagedMedia,
  resolveManagedMediaReference
} from '../llmProxy/managedMediaStore'

export type ImportSourceAuthorization = { canonicalPath: string; viaImportGrant: boolean }

export type ManagedMediaSvcImplDependencies = {
  importFile?: typeof importManagedMediaFile
  importBytes?: typeof importManagedMedia
  ensureDerivative?: typeof ensureManagedMediaDerivative
  getMediaDir?: typeof getChatMediaDir
  getMediaNamespaceDir?: typeof getChatMediaNamespaceDir
  realpath?: typeof fs.realpath
  readMediaBytes?: typeof readManagedMediaBytes
  resolveReference?: typeof resolveManagedMediaReference
  migrateLegacy?: typeof migrateLegacyBase64MediaOnDemand
  /**
   * Source-path policy for importFile requests that come from a renderer. Returns the
   * canonical path when the path is under an application root or was granted (a file the
   * user picked), otherwise null; viaImportGrant when only a one-use import grant covers it.
   * It spends nothing. When set, importFile refuses every path it does not return unchanged.
   * Main-owned callers that confine paths themselves leave it unset.
   */
  authorizeImportSourcePath?: (
    sourcePath: string
  ) => ImportSourceAuthorization | null | Promise<ImportSourceAuthorization | null>
  /**
   * Spends one import grant for a canonical path, now; false or null when none is live. An
   * object answer is told when the import is over (finished()), whatever its outcome.
   */
  consumeImportGrant?: (canonicalPath: string) => boolean | { finished(): void } | null
  /** Byte cap for importFile, checked on the stat and again on the bytes actually copied. */
  maxImportFileBytes?: number
  /** Deadlines for the source's filesystem calls and copy (renderer-named sources). */
  importSourceGuard?: ImportSourceGuard
  updateReferenceSnapshot?: (snapshot: {
    complete: boolean
    ids: readonly string[]
    referenceCounts?: Readonly<Record<string, number>>
  }) => void | Promise<void>
}

const invalidDependencyResult = (): ServiceError =>
  new ServiceError('Unable to prepare managed media derivative', {
    code: 'MANAGED_MEDIA_DERIVATIVE_FAILED'
  })

function importResponse(
  imported: ImportedManagedMedia,
  authorizedRoot: string
): ImportManagedMediaResp {
  const reference = normalizeMediaReference(imported.reference)
  if (!reference || reference.kind !== 'managed') {
    throw new ServiceError('Unable to import managed media', {
      code: 'MANAGED_MEDIA_IMPORT_FAILED'
    })
  }
  const canonicalImportedPath = path.resolve(imported.absolutePath)
  const canonicalAuthorizedRoot = path.resolve(authorizedRoot)
  const relativePath = path
    .relative(canonicalAuthorizedRoot, canonicalImportedPath)
    .split(path.sep)
    .join('/')
  const importedReferencePath = reference.relativePath
  const scopedPhysicalPath =
    /^(?:codex-images(?:\/|-[a-z0-9_](?:[a-z0-9._-]{0,126}[a-z0-9_])?\/)|(?:task|model|user-output)\/[a-z0-9_](?:[a-z0-9._-]{0,126}[a-z0-9_])?\/)/u
  const expectedReferencePath = scopedPhysicalPath.test(relativePath)
    ? relativePath
    : importedReferencePath
  if (
    !relativePath ||
    path.isAbsolute(relativePath) ||
    relativePath.startsWith('../') ||
    relativePath.includes('\\') ||
    (scopedPhysicalPath.test(relativePath) && importedReferencePath !== relativePath) ||
    !isPathInsideRoot(
      canonicalAuthorizedRoot,
      path.join(canonicalAuthorizedRoot, ...expectedReferencePath.split('/'))
    )
  ) {
    throw new ServiceError('Unable to import managed media', {
      code: 'MANAGED_MEDIA_IMPORT_FAILED'
    })
  }
  const absolutePath = path.join(canonicalAuthorizedRoot, ...expectedReferencePath.split('/'))
  const fileUrl = pathToFileURL(absolutePath).toString()
  return validateImportManagedMediaResp({
    reference,
    localMediaUrl: `local-media://${fileUrl.slice('file://'.length)}`
  })
}

type ManagedMediaImportRoots = {
  /** Physical store used for this import; always contained by authorizedRoot. */
  importRoot: string
  /** Base `.chat_media` root used to authorize and later resolve references. */
  authorizedRoot: string
}

/** Byte cap for importFile requests from the renderer (the composer allows up to 500 MB). */
export const MANAGED_MEDIA_IMPORT_FILE_MAX_BYTES = 1024 * 1024 * 1024

const invalidImportSource = (): ServiceError =>
  new ServiceError('Managed media source must be a canonical absolute local file path', {
    code: 'MANAGED_MEDIA_IMPORT_INVALID'
  })

export type ImportSourcePathOptions = {
  pathApi?: Pick<typeof path, 'isAbsolute' | 'normalize'>
  toPath?: (url: URL) => string
  /** Default true; main-owned callers that confine paths themselves may allow UNC paths. */
  refuseNetworkAndDevicePaths?: boolean
  /** Windows path rules; defaults to whether pathApi is path.win32 (true on Windows). */
  windows?: boolean
}

/**
 * Turn an importFile sourcePath (absolute path or file: URI) into a local path, without
 * touching the filesystem. Refused: other URI schemes, relative or non-normalized paths and,
 * by default, UNC and Win32 device or long-path namespace paths (\\server\share, \\?\,
 * \\.\ and the NT object-namespace prefix '\' + '?' + '?' + '\'), which would make main contact a
 * remote host or a device before any other
 * check, and Windows alternate data streams. On Windows a refused-by-default path must also
 * be a plain drive-letter path that does not end in a reserved device name (CON, COM1.png).
 * Errors never contain the path.
 */
export function toImportSourceLocalPath(
  value: string,
  {
    pathApi = path,
    toPath = (url) => fileURLToPath(url),
    refuseNetworkAndDevicePaths = true,
    windows = pathApi === path.win32
  }: ImportSourcePathOptions = {}
): string {
  const raw = String(value || '')
  if (!raw || raw.includes('\0')) throw invalidImportSource()
  const isUri = /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(raw) && !/^[A-Za-z]:[\\/]/u.test(raw)
  if (isUri && !raw.startsWith('file:')) throw invalidImportSource()
  let sourcePath: string
  try {
    sourcePath = isUri ? toPath(new URL(raw)) : raw
  } catch {
    throw invalidImportSource()
  }
  if (
    (refuseNetworkAndDevicePaths &&
      (/^[\\/]{2}/u.test(sourcePath) ||
        // NT object namespace: the '\' + '?' + '?' + '\' prefix, before UNC\host\share or C:\...
        /^[\\/][?]{2}[\\/]/u.test(sourcePath) ||
        (/^[A-Za-z]:[\\/]/u.test(sourcePath) && sourcePath.slice(2).includes(':')) ||
        (windows &&
          (!/^[A-Za-z]:\\/u.test(sourcePath) ||
            WINDOWS_DEVICE_NAME.test(sourcePath.split(/[\\/]/u).pop() || ''))))) ||
    !pathApi.isAbsolute(sourcePath) ||
    pathApi.normalize(sourcePath) !== sourcePath
  ) {
    throw invalidImportSource()
  }
  return sourcePath
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/**
 * Whether `payload` (already restricted to the base64 alphabet with at most two trailing '=')
 * is the canonical padded encoding of its bytes, i.e. what Buffer#toString('base64') would
 * return, without building that second string: padded to a multiple of four, and the unused
 * low bits of the last data character zero.
 */
export function isCanonicalBase64Payload(payload: string): boolean {
  if (!payload.length || payload.length % 4 !== 0) return false
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0
  if (padding === 0) return true
  const last = BASE64_ALPHABET.indexOf(payload[payload.length - padding - 1])
  if (last < 0) return false
  return (last & (padding === 2 ? 0x0f : 0x03)) === 0
}

function sameFilesystemPath(left: string, right: string): boolean {
  const a = path.resolve(left)
  const b = path.resolve(right)
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

async function resolveImportRoots(
  storage: ManagedMediaStorage | undefined,
  dependencies: ManagedMediaSvcImplDependencies
): Promise<ManagedMediaImportRoots> {
  const getMediaDir = dependencies.getMediaDir ?? getChatMediaDir
  const realpath = dependencies.realpath ?? fs.realpath
  const baseRoot = getMediaDir()
  const authorizedRoot = await realpath(baseRoot)
  // Do not turn a symlinked `.chat_media` directory into the authorization
  // root. The store's canonical-root checks rely on this boundary remaining
  // the app-owned path selected by Electron.
  if (!sameFilesystemPath(baseRoot, authorizedRoot)) {
    throw new ServiceError('Managed media root is not a canonical directory', {
      code: 'MANAGED_MEDIA_IMPORT_INVALID'
    })
  }
  if (!storage) return { importRoot: baseRoot, authorizedRoot }

  // The namespace helper rejects unknown namespaces and non-canonical scopes;
  // the containment check below also protects injected test/host adapters.
  const namespaceDir = (dependencies.getMediaNamespaceDir ?? getChatMediaNamespaceDir)(
    storage.namespace,
    storage.scope
  )
  const canonicalNamespaceDir = await realpath(namespaceDir)
  if (!isPathInsideRoot(authorizedRoot, canonicalNamespaceDir)) {
    throw new ServiceError('Managed media storage namespace is not authorized', {
      code: 'MANAGED_MEDIA_IMPORT_INVALID'
    })
  }
  return { importRoot: canonicalNamespaceDir, authorizedRoot }
}

function readyDescriptor(
  result: EnsureManagedMediaDerivativeResult,
  requestedMaxEdge: EnsureManagedMediaDerivativeReq['maxEdge']
): ManagedMediaDerivativeDescriptor | undefined {
  if (
    result.purpose !== 'managed-media-derivative' ||
    result.maxEdge !== requestedMaxEdge ||
    result.mimeType !== 'image/webp' ||
    !result.relativePath.endsWith('.webp') ||
    Math.max(result.width, result.height) > requestedMaxEdge
  ) {
    return undefined
  }

  const response = {
    status: 'ready' as const,
    descriptor: {
      maxEdge: result.maxEdge,
      relativePath: result.relativePath,
      mimeType: result.mimeType,
      sizeBytes: result.sizeBytes,
      width: result.width,
      height: result.height,
      sha256: result.sha256,
      localMediaUrl: result.localMediaUrl
    }
  }
  try {
    return validateEnsureManagedMediaDerivativeResp(response).status === 'ready'
      ? response.descriptor
      : undefined
  } catch {
    return undefined
  }
}

export class ManagedMediaSvcImpl implements ManagedMediaSvc {
  constructor(private readonly dependencies: ManagedMediaSvcImplDependencies = {}) {}

  async updateReferenceSnapshot(
    req: UpdateManagedMediaReferenceSnapshotReq
  ): Promise<UpdateManagedMediaReferenceSnapshotResp> {
    await this.dependencies.updateReferenceSnapshot?.({
      complete: req.complete,
      ids: req.ids,
      ...(req.referenceCounts ? { referenceCounts: req.referenceCounts } : {})
    })
    return { version: 1, accepted: true }
  }

  async importFile(req: ImportManagedMediaFileReq): Promise<ImportManagedMediaResp> {
    let grantUse: { finished(): void } | undefined
    try {
      // Every check that needs no filesystem access comes first.
      const authorize = this.dependencies.authorizeImportSourcePath
      const sourcePath = toImportSourceLocalPath(req.sourcePath, {
        refuseNetworkAndDevicePaths: Boolean(authorize)
      })
      if (!isManagedMediaMimeTypeSupported(req.mimeType)) {
        throw new ServiceError('Unsupported managed media type', {
          code: 'MANAGED_MEDIA_UNSUPPORTED'
        })
      }
      if (authorize) {
        const forbidden = () =>
          new ServiceError('Managed media source is not an allowed file', {
            code: 'MANAGED_MEDIA_IMPORT_FORBIDDEN'
          })
        // The authorized form must be the requested path itself: no symlink, alias or
        // case variant of an allowed path is followed to somewhere else.
        const authorized = await authorize(sourcePath)
        if (!authorized || !sameFilesystemPath(authorized.canonicalPath, sourcePath)) {
          throw forbidden()
        }
        // A one-use import grant is spent only now: after the checks above and only when the
        // authorization answered within its deadline (a late answer never reaches here), its
        // time to live judged at this moment. Synchronous, so two imports cannot share it.
        if (authorized.viaImportGrant) {
          const used = this.dependencies.consumeImportGrant?.(authorized.canonicalPath)
          if (!used) throw forbidden()
          if (typeof used === 'object') grantUse = used
        }
      }
      const { importRoot, authorizedRoot } = await resolveImportRoots(
        req.storage,
        this.dependencies
      )
      // The store re-checks on the open handle: regular non-symlink file (no directory,
      // FIFO or device), canonical, outside the store, same file and size before and
      // after the copy, the cap on the bytes actually copied, image bytes on the copy.
      const imported = await (this.dependencies.importFile ?? importManagedMediaFile)(
        {
          chatMediaRoot: importRoot,
          sourcePath,
          mimeType: req.mimeType,
          originalFileName: req.originalFileName,
          provenance: { source: 'chat-attachment-file' },
          ...(this.dependencies.maxImportFileBytes !== undefined
            ? { maxBytes: this.dependencies.maxImportFileBytes }
            : {}),
          ...(this.dependencies.importSourceGuard
            ? { sourceGuard: this.dependencies.importSourceGuard }
            : {})
        },
        { authorizedRoot }
      )
      const response = importResponse(imported, authorizedRoot)
      void (this.dependencies.ensureDerivative ?? ensureManagedMediaDerivative)({
        authorizedRoot,
        reference: response.reference,
        maxEdge: 2048
      }).catch(() => undefined)
      return response
    } catch (error) {
      if (error instanceof ServiceError) throw error
      if (error instanceof ManagedMediaImportError) {
        throw new ServiceError(error.message, { code: error.code })
      }
      throw new ServiceError('Unable to import managed media file', {
        code: 'MANAGED_MEDIA_IMPORT_FAILED'
      })
    } finally {
      // The next file of the same drop may now be imported (see spendLocalMediaImportGrant).
      grantUse?.finished()
    }
  }

  async migrateLegacyDataUrl(
    req: MigrateLegacyManagedMediaReq
  ): Promise<MigrateLegacyManagedMediaResp> {
    try {
      const { importRoot, authorizedRoot } = await resolveImportRoots(
        req.storage,
        this.dependencies
      )
      const result = await (this.dependencies.migrateLegacy ?? migrateLegacyBase64MediaOnDemand)({
        value: req.dataUrl,
        chatMediaRoot: importRoot,
        authorizedRoot,
        rollbackToken: null,
        provenance: {
          sourceWidth: req.metadata.sourceWidth,
          sourceHeight: req.metadata.sourceHeight
        }
      })
      if (result.status !== 'migrated') throw new Error('Legacy media was not migrated')
      const imported = importResponse(result.imported, authorizedRoot)
      return validateMigrateLegacyManagedMediaResp({
        ...imported,
        checkpoint: { version: 1, reclaim: { reference: imported.reference } }
      })
    } catch (error) {
      if (error instanceof ServiceError) throw error
      if (error instanceof ManagedMediaImportError) {
        throw new ServiceError(error.message, { code: error.code })
      }
      throw new ServiceError('Unable to migrate legacy managed media', {
        code: 'MANAGED_MEDIA_IMPORT_FAILED'
      })
    }
  }

  async reclaimLegacyMigration(
    req: ReclaimLegacyManagedMediaReq
  ): Promise<ReclaimLegacyManagedMediaResp> {
    try {
      const mediaDir = this.dependencies.getMediaDir?.() ?? getChatMediaDir()
      const authorizedRoot = await (this.dependencies.realpath ?? fs.realpath)(mediaDir)
      const reference = normalizeMediaReference(req.reclaim.reference)
      if (!reference || reference.kind !== 'managed') throw new Error('Invalid reclaim reference')
      // Publish one record atomically so a poison record cannot block later migrations.
      const spoolDir = path.join(authorizedRoot, '.legacy-migration-reclaim')
      let spoolStat: Awaited<ReturnType<typeof fs.lstat>> | undefined
      try {
        spoolStat = await fs.lstat(spoolDir)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      if (!spoolStat) await fs.mkdir(spoolDir)
      spoolStat = await fs.lstat(spoolDir)
      if (
        !spoolStat.isDirectory() ||
        spoolStat.isSymbolicLink() ||
        path.resolve(await fs.realpath(spoolDir)) !== path.resolve(spoolDir)
      )
        throw new Error('Unsafe reclaim spool')
      const nonce = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
      const temporary = path.join(spoolDir, `${nonce}.tmp`)
      const published = path.join(spoolDir, `${nonce}.json`)
      try {
        await fs.writeFile(
          temporary,
          `${JSON.stringify({ version: 1, reference, attempts: 0 })}
`,
          { encoding: 'utf8', flag: 'wx' }
        )
        await fs.rename(temporary, published)
      } catch (error) {
        await fs.rm(temporary, { force: true }).catch(() => undefined)
        throw error
      }
      return { queued: true }
    } catch {
      throw new ServiceError('Unable to queue legacy managed media reclaim', {
        code: 'MANAGED_MEDIA_IMPORT_FAILED'
      })
    }
  }

  /** Kept for older callers; new path-less callers send bytes through importBytes. */
  async importDataUrl(req: ImportManagedMediaDataUrlReq): Promise<ImportManagedMediaResp> {
    try {
      const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]+={0,2})$/.exec(req.dataUrl)
      if (!match) throw new Error('Invalid data URL')
      // Canonical-base64 check on the payload itself: no re-encoded copy of a string that
      // can be hundreds of MB.
      if (!isCanonicalBase64Payload(match[2])) throw new Error('Invalid base64')
      const bytes = Buffer.from(match[2], 'base64')
      if (!bytes.length) throw new Error('Invalid base64')
      return await this.importBytesInto(req.storage, {
        bytes,
        mimeType: match[1],
        originalFileName: req.originalFileName,
        provenance: { source: 'chat-attachment-data-url' }
      })
    } catch (error) {
      if (error instanceof ServiceError) throw error
      if (error instanceof ManagedMediaImportError) {
        throw new ServiceError(error.message, { code: error.code })
      }
      throw new ServiceError('Unable to import managed media data URL', {
        code: 'MANAGED_MEDIA_IMPORT_FAILED'
      })
    }
  }

  async importBytes(req: ImportManagedMediaBytesReq): Promise<ImportManagedMediaResp> {
    try {
      // Direct MAIN callers skip the IPC validator: repeat its limits here.
      if (
        !(req.bytes instanceof Uint8Array) ||
        req.bytes.byteLength <= 0 ||
        req.bytes.byteLength > MANAGED_MEDIA_IMPORT_BYTES_MAX_BYTES
      ) {
        throw new ServiceError('Managed media bytes are empty or above the import limit', {
          code: 'MANAGED_MEDIA_TOO_LARGE'
        })
      }
      if (!isManagedMediaMimeTypeSupported(req.mimeType)) {
        throw new ServiceError('Unsupported managed media type', {
          code: 'MANAGED_MEDIA_UNSUPPORTED'
        })
      }
      return await this.importBytesInto(req.storage, {
        bytes: req.bytes,
        mimeType: req.mimeType,
        originalFileName: req.originalFileName,
        provenance: { source: 'chat-attachment-bytes' },
        maxBytes: MANAGED_MEDIA_IMPORT_BYTES_MAX_BYTES
      })
    } catch (error) {
      if (error instanceof ServiceError) throw error
      if (error instanceof ManagedMediaImportError) {
        throw new ServiceError(error.message, { code: error.code })
      }
      throw new ServiceError('Unable to import managed media bytes', {
        code: 'MANAGED_MEDIA_IMPORT_FAILED'
      })
    }
  }

  private async importBytesInto(
    storage: ManagedMediaStorage | undefined,
    input: Parameters<typeof importManagedMedia>[1]
  ): Promise<ImportManagedMediaResp> {
    const { importRoot, authorizedRoot } = await resolveImportRoots(storage, this.dependencies)
    const imported = await (this.dependencies.importBytes ?? importManagedMedia)(
      importRoot,
      input,
      { authorizedRoot }
    )
    const response = importResponse(imported, authorizedRoot)
    void (this.dependencies.ensureDerivative ?? ensureManagedMediaDerivative)({
      authorizedRoot,
      reference: response.reference,
      maxEdge: 2048
    }).catch(() => undefined)
    return response
  }

  async ensureDerivative(
    req: EnsureManagedMediaDerivativeReq
  ): Promise<EnsureManagedMediaDerivativeResp> {
    const getMediaDir = this.dependencies.getMediaDir ?? getChatMediaDir
    const realpath = this.dependencies.realpath ?? fs.realpath
    const derive = this.dependencies.ensureDerivative ?? ensureManagedMediaDerivative

    try {
      // getMediaDir is the sole authority for both dependency injection and production roots.
      const authorizedRoot = await realpath(getMediaDir())
      const result: EnsureManagedMediaDerivativeResult = await derive({
        authorizedRoot,
        reference: req.reference,
        maxEdge: req.maxEdge
      })

      if (result.purpose === 'original-fallback') {
        if (
          result.status !== 'unsupported' ||
          result.reason !== 'animated-gif' ||
          result.maxEdge !== req.maxEdge ||
          !result.original ||
          result.original.metadata?.mimeType !== 'image/gif'
        ) {
          throw invalidDependencyResult()
        }
        const response = {
          status: 'fallbackOriginal' as const,
          reason: 'animated-gif' as const,
          localMediaUrl: result.original.localMediaUrl
        }
        return validateEnsureManagedMediaDerivativeResp(response)
      }

      const descriptor = readyDescriptor(result, req.maxEdge)
      if (!descriptor) throw invalidDependencyResult()
      return { status: 'ready', descriptor }
    } catch (error) {
      if (error instanceof ManagedMediaResolutionError) {
        throw new ServiceError(
          error.code === 'MANAGED_MEDIA_MISSING'
            ? 'Managed media is missing'
            : 'Managed media is corrupt',
          { code: error.code }
        )
      }
      if (error instanceof ServiceError) throw error
      // The preview could not be made (no image worker in a dev build, a worker that failed
      // or timed out): show the stored original, resolved as a request would read it, rather
      // than nothing. A missing or corrupt original still fails above.
      const localMediaUrl = await this.resolveOriginalLocalMediaUrl(req.reference).catch(() => null)
      if (localMediaUrl) {
        return validateEnsureManagedMediaDerivativeResp({
          status: 'fallbackOriginal',
          reason: 'derivative-unavailable',
          localMediaUrl
        })
      }
      throw invalidDependencyResult()
    }
  }

  private async resolveOriginalLocalMediaUrl(
    reference: EnsureManagedMediaDerivativeReq['reference']
  ): Promise<string> {
    const getMediaDir = this.dependencies.getMediaDir ?? getChatMediaDir
    const realpath = this.dependencies.realpath ?? fs.realpath
    const resolveReference = this.dependencies.resolveReference ?? resolveManagedMediaReference
    const mediaDir = getMediaDir()
    const authorizedRoot = await realpath(mediaDir)
    const resolved = await resolveReference(mediaDir, reference, { authorizedRoot })
    return resolved.localMediaUrl
  }

  async materializeForRequest(
    req: Extract<MaterializeManagedMediaForRequestReq, { transport: 'request-data-url' }>
  ): Promise<Extract<MaterializeManagedMediaForRequestResp, { transport: 'request-data-url' }>>
  async materializeForRequest(
    req: Extract<MaterializeManagedMediaForRequestReq, { transport: 'chunked-binary-v1' }>
  ): Promise<Extract<MaterializeManagedMediaForRequestResp, { transport: 'chunked-binary-v1' }>>
  async materializeForRequest(
    req: MaterializeManagedMediaForRequestReq
  ): Promise<MaterializeManagedMediaForRequestResp>
  async materializeForRequest(
    req: MaterializeManagedMediaForRequestReq
  ): Promise<MaterializeManagedMediaForRequestResp> {
    // Snapshot and revalidate before the first await, including direct MAIN callers.
    // A caller-supplied cap only restricts this materialization; it grants no access.
    const request = validateMaterializeManagedMediaForRequestReq(req)
    const { reference, maxBytes } = request
    if (maxBytes !== undefined && reference.sizeBytes! > maxBytes) {
      throw new ServiceError('Managed media exceeds the request byte limit', {
        code: 'MANAGED_MEDIA_REQUEST_SIZE_LIMIT'
      })
    }
    const getMediaDir = this.dependencies.getMediaDir ?? getChatMediaDir
    const realpath = this.dependencies.realpath ?? fs.realpath
    const readMediaBytes = this.dependencies.readMediaBytes ?? readManagedMediaBytes
    const resolveReference = this.dependencies.resolveReference ?? resolveManagedMediaReference
    try {
      const mediaDir = getMediaDir()
      const authorizedRoot = await realpath(mediaDir)
      const resolved = await resolveReference(mediaDir, reference, { authorizedRoot })
      const selected: Parameters<typeof readManagedMediaBytes>[1] = resolved.metadata
      const bytes = await readMediaBytes(resolved.storeRoot ?? authorizedRoot, selected, {
        authorizedRoot,
        ...(maxBytes !== undefined ? { maxBytes } : {})
      })
      if (request.transport === 'chunked-binary-v1') {
        const transport = await createBinaryChunkTransport(bytes, {
          mimeType: selected.mimeType
        })
        return validateMaterializeManagedMediaForRequestResp({
          transport: 'chunked-binary-v1',
          reference: transport.reference,
          chunks: transport.chunks
        })
      }
      return validateMaterializeManagedMediaForRequestResp({
        transport: 'request-data-url',
        dataUrl: `data:${selected.mimeType};base64,${bytes.toString('base64')}`,
        mimeType: selected.mimeType,
        sizeBytes: bytes.byteLength
      })
    } catch (error) {
      if (error instanceof ManagedMediaResolutionError) {
        throw new ServiceError(
          error.code === 'MANAGED_MEDIA_MISSING'
            ? 'Managed media is missing'
            : 'Managed media is corrupt',
          { code: error.code }
        )
      }
      if (error instanceof ServiceError) throw error
      throw new ServiceError('Unable to materialize managed media for request', {
        code: 'MANAGED_MEDIA_REQUEST_MATERIALIZATION_FAILED'
      })
    }
  }
}
