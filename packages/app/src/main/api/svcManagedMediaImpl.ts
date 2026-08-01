import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type {
  EnsureManagedMediaDerivativeReq,
  EnsureManagedMediaDerivativeResp,
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
  MaterializeManagedMediaForRequestReq,
  MaterializeManagedMediaForRequestResp
} from '@shared/api/svcManagedMedia'
import {
  validateEnsureManagedMediaDerivativeResp,
  validateImportManagedMediaResp,
  validateMigrateLegacyManagedMediaResp,
  validateMaterializeManagedMediaForRequestResp
} from '@shared/api/svcManagedMedia'
import { ServiceError } from '@shared/api/apiUtils/serviceValidation'
import { normalizeMediaReference } from '@shared/mediaReference'
import { getChatMediaDir } from '../llmProxy/chatMediaDir'
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
  type ImportedManagedMedia,
  resolveManagedMediaReference
} from '../llmProxy/managedMediaStore'

export type ManagedMediaSvcImplDependencies = {
  importFile?: typeof importManagedMediaFile
  importBytes?: typeof importManagedMedia
  ensureDerivative?: typeof ensureManagedMediaDerivative
  getMediaDir?: typeof getChatMediaDir
  realpath?: typeof fs.realpath
  readFile?: typeof fs.readFile
  resolveReference?: typeof resolveManagedMediaReference
  migrateLegacy?: typeof migrateLegacyBase64MediaOnDemand
  updateReferenceSnapshot?: (snapshot: {
    complete: boolean
    ids: readonly string[]
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
  const absolutePath = path.join(authorizedRoot, ...reference.relativePath.split('/'))
  const fileUrl = pathToFileURL(absolutePath).toString()
  return validateImportManagedMediaResp({
    reference,
    localMediaUrl: `local-media://${fileUrl.slice('file://'.length)}`
  })
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
    await this.dependencies.updateReferenceSnapshot?.({ complete: req.complete, ids: req.ids })
    return { version: 1, accepted: true }
  }

  async importFile(req: ImportManagedMediaFileReq): Promise<ImportManagedMediaResp> {
    try {
      const mediaDir = this.dependencies.getMediaDir?.() ?? getChatMediaDir()
      const authorizedRoot = await (this.dependencies.realpath ?? fs.realpath)(mediaDir)
      const isUri = /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(req.sourcePath)
      if (isUri && !req.sourcePath.startsWith('file:')) {
        throw new ServiceError('Managed media source must be a file URI or absolute path', {
          code: 'MANAGED_MEDIA_IMPORT_INVALID'
        })
      }
      const sourcePath = isUri ? fileURLToPath(new URL(req.sourcePath)) : req.sourcePath
      if (!path.isAbsolute(sourcePath) || path.normalize(sourcePath) !== sourcePath) {
        throw new ServiceError('Managed media source path must be canonical and absolute', {
          code: 'MANAGED_MEDIA_IMPORT_INVALID'
        })
      }
      const imported = await (this.dependencies.importFile ?? importManagedMediaFile)(
        {
          chatMediaRoot: mediaDir,
          sourcePath,
          mimeType: req.mimeType,
          originalFileName: req.originalFileName,
          provenance: { source: 'chat-attachment-file' }
        },
        { authorizedRoot }
      )
      return importResponse(imported, authorizedRoot)
    } catch (error) {
      if (error instanceof ServiceError) throw error
      if (error instanceof ManagedMediaImportError) {
        throw new ServiceError(error.message, { code: error.code })
      }
      throw new ServiceError('Unable to import managed media file', {
        code: 'MANAGED_MEDIA_IMPORT_FAILED'
      })
    }
  }

  async migrateLegacyDataUrl(
    req: MigrateLegacyManagedMediaReq
  ): Promise<MigrateLegacyManagedMediaResp> {
    try {
      const mediaDir = this.dependencies.getMediaDir?.() ?? getChatMediaDir()
      const authorizedRoot = await (this.dependencies.realpath ?? fs.realpath)(mediaDir)
      const result = await (this.dependencies.migrateLegacy ?? migrateLegacyBase64MediaOnDemand)({
        value: req.dataUrl,
        chatMediaRoot: mediaDir,
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
      // Content-addressed imports may be shared. Queue a durable cleanup candidate instead of
      // deleting the file here; the cleanup pass can prove it is unreferenced before removal.
      const queuePath = path.join(authorizedRoot, 'legacy-migration-reclaim.jsonl')
      await fs.appendFile(queuePath, `${JSON.stringify({ version: 1, reference })}\n`, {
        encoding: 'utf8',
        flag: 'a'
      })
      return { queued: true }
    } catch {
      throw new ServiceError('Unable to queue legacy managed media reclaim', {
        code: 'MANAGED_MEDIA_IMPORT_FAILED'
      })
    }
  }

  async importDataUrl(req: ImportManagedMediaDataUrlReq): Promise<ImportManagedMediaResp> {
    try {
      const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]+={0,2})$/.exec(req.dataUrl)
      if (!match) throw new Error('Invalid data URL')
      const bytes = Buffer.from(match[2], 'base64')
      if (!bytes.length || bytes.toString('base64') !== match[2]) throw new Error('Invalid base64')
      const mediaDir = this.dependencies.getMediaDir?.() ?? getChatMediaDir()
      const authorizedRoot = await (this.dependencies.realpath ?? fs.realpath)(mediaDir)
      const imported = await (this.dependencies.importBytes ?? importManagedMedia)(
        mediaDir,
        {
          bytes,
          mimeType: match[1],
          originalFileName: req.originalFileName,
          provenance: { source: 'chat-attachment-data-url' }
        },
        { authorizedRoot }
      )
      return importResponse(imported, authorizedRoot)
    } catch (error) {
      if (error instanceof ManagedMediaImportError) {
        throw new ServiceError(error.message, { code: error.code })
      }
      throw new ServiceError('Unable to import managed media data URL', {
        code: 'MANAGED_MEDIA_IMPORT_FAILED'
      })
    }
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
      throw invalidDependencyResult()
    }
  }

  async materializeForRequest(
    req: MaterializeManagedMediaForRequestReq
  ): Promise<MaterializeManagedMediaForRequestResp> {
    const getMediaDir = this.dependencies.getMediaDir ?? getChatMediaDir
    const realpath = this.dependencies.realpath ?? fs.realpath
    const readFile = this.dependencies.readFile ?? fs.readFile
    const resolveReference = this.dependencies.resolveReference ?? resolveManagedMediaReference
    try {
      const mediaDir = getMediaDir()
      const authorizedRoot = await realpath(mediaDir)
      const resolved = await resolveReference(mediaDir, req.reference, { authorizedRoot })
      const bytes = await readFile(resolved.absolutePath)
      return validateMaterializeManagedMediaForRequestResp({
        transport: 'request-data-url',
        dataUrl: `data:${resolved.reference.mimeType};base64,${bytes.toString('base64')}`,
        mimeType: resolved.reference.mimeType,
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
