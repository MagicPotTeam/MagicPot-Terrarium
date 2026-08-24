import { ServiceDefSheet } from './apiUtils/serviceDefSheet'
import { ServiceValidationError } from './apiUtils/serviceValidation'

/**
 * 文件系统相关 API
 * 用于批量处理等需要直接操作文件系统的功能
 */

export type ListImagesInFolderReq = {
  folderPath: string
}

export type ListImagesInFolderResp = {
  images: {
    filename: string
    fullPath: string
  }[]
}

export type ListFilesInFolderReq = {
  folderPath: string
  extensions?: string[]
  recursive?: boolean
}

export type ListFilesInFolderResp = {
  files: {
    filename: string
    fullPath: string
    lastModifiedMs: number
  }[]
}

export type PruneAutoSaveProjectsReq = {
  currentProjectDirName: string
  maxProjects: number
}

export type PruneAutoSaveProjectsResp = {
  removedProjectDirs: string[]
}

export type SaveImageToPathReq = {
  image: Uint8Array
  outputPath: string
  filename: string
}

export type SaveImageToPathResp = {
  success: boolean
  fullPath: string
}

export type SaveQAppInputImageReq = {
  image: Uint8Array
  filename: string
}

export type SaveQAppInputImageResp = {
  success: boolean
  fullPath: string
  filename: string
}

export type ReadImageFromPathReq = {
  fullPath: string
}

export type ReadImageFromPathResp = {
  image: Uint8Array
  filename: string
}

export type ReadTextFileReq = {
  fullPath: string
}

export type ReadTextFileResp = {
  content: string
  filename: string
}

export type ReadFileFromPathReq = {
  fullPath: string
}

export type ReadFileFromPathResp = {
  data: Uint8Array
  filename: string
}

export type ReadFileSliceReq = {
  fullPath: string
  offset?: number
  length: number
}

export type ReadFileSliceResp = {
  data: Uint8Array
  filename: string
  fileSizeBytes: number
}

export type WriteTextFileReq = {
  outputPath: string
  filename: string
  content: string
}

export type WriteTextFileResp = {
  success: boolean
  fullPath: string
}

export type ReadLoraTriggerWordsNativeReq = {
  loraDir: string
  loraName: string
}

export type ReadLoraTriggerWordsNativeResp = {
  triggerWords: string
  source: string
  nativeAvailable: boolean
}

export const BATCH_MANIFEST_VERSION = 1 as const

export type BatchImageFile = {
  relativePath: string
  absolutePath: string
  size: number
  mtimeMs: number
}

export type BatchScanError = {
  relativePath: string
  message: string
}

export type ScanBatchImagesReq = {
  sourceRoot: string
}

export type ScanBatchImagesResp = {
  images: BatchImageFile[]
  errors: BatchScanError[]
}

export type BatchSourceFingerprint = {
  size: number
  mtimeMs: number
}

export type BatchItemStatus = 'pending' | 'running' | 'succeeded' | 'failed'

export type BatchAttemptRecord = {
  startedAt: string
  finishedAt?: string
  error?: string
}

export type BatchManifestItem = {
  relativeInputPath: string
  outputRelativePath: string
  sourceFingerprint: BatchSourceFingerprint
  status: BatchItemStatus
  quickAppId?: string
  quickAppRevision?: string
  attempts: BatchAttemptRecord[]
}

export type BatchManifest = {
  version: typeof BATCH_MANIFEST_VERSION
  sourceRoot: string
  createdAt: string
  updatedAt: string
  items: BatchManifestItem[]
}

export type BatchWorkspacePaths = {
  sourceRoot: string
  workRoot: string
  outputRoot: string
  metadataRoot: string
  stagingRoot: string
  manifestPath: string
}

export type PrepareBatchWorkspaceReq = {
  sourceRoot: string
  /** Must be explicitly accepted by the folder-picker UI before sibling roots are created. */
  userAuthorized: true
}

export type PrepareBatchWorkspaceResp = {
  paths: BatchWorkspacePaths
  manifest: BatchManifest
  images: BatchImageFile[]
  skippedRelativePaths: string[]
  scanErrors: BatchScanError[]
}

export type ReadBatchManifestReq = {
  sourceRoot: string
}

export type ReadBatchManifestResp = {
  manifest: BatchManifest | null
  manifestPath: string
}

export type WriteBatchManifestReq = {
  sourceRoot: string
  manifest: BatchManifest
}

export type WriteBatchManifestResp = {
  manifestPath: string
}

export type ReadBatchSourceImageReq = {
  sourceRoot: string
  relativeInputPath: string
  sourceFingerprint: BatchSourceFingerprint
}

export type ReadBatchSourceImageResp = {
  image: Uint8Array
  filename: string
}

export type CommitBatchPngReq = {
  sourceRoot: string
  relativeInputPath: string
  sourceFingerprint: BatchSourceFingerprint
  image: Uint8Array
}

export type CommitBatchPngResp = {
  outputRelativePath: string
  outputPath: string
}

export type RemoveBatchStagingArtifactsReq = {
  sourceRoot: string
  relativeInputPath: string
}

export type RemoveBatchStagingArtifactsResp = {
  removedPaths: string[]
}

export type FailBatchItemReq = {
  sourceRoot: string
  relativeInputPath: string
  errorLog: string
}

export type FailBatchItemResp = {
  errorLogPath: string
  removedOutputPaths: string[]
}

export const MAX_READ_FILE_SLICE_BYTES = 16 * 1024 * 1024
export const MAX_FULL_FILE_BYTES = 256 * 1024 * 1024
export const MAX_TEXT_FILE_BYTES = 8 * 1024 * 1024
export const MAX_FILENAME_LENGTH = 255

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const validationError = (method: string, field: string, message: string): never => {
  throw new ServiceValidationError(`svcFs.${method} ${field}`, [
    { path: [field], message, code: 'invalid_type' }
  ])
}

const requireRecord = (value: unknown, method: string): Record<string, unknown> => {
  if (isRecord(value)) return value
  throw new ServiceValidationError(`svcFs.${method} request`)
}

const requireNonEmptyString = (value: unknown, method: string, field: string): string => {
  if (typeof value === 'string' && value.trim()) return value
  return validationError(method, field, 'Expected a non-empty string')
}

const requireBasename = (value: unknown, method: string): string => {
  const filename = requireNonEmptyString(value, method, 'filename')
  if (
    filename.length > MAX_FILENAME_LENGTH ||
    filename === '.' ||
    filename === '..' ||
    filename.includes('/') ||
    filename.includes('\\') ||
    filename.includes('\0')
  ) {
    return validationError(
      method,
      'filename',
      `Expected a basename no longer than ${MAX_FILENAME_LENGTH} characters`
    )
  }
  return filename
}

const requireUint8Array = (value: unknown, method: string, field: string): Uint8Array => {
  if (value instanceof Uint8Array && value.byteLength <= MAX_FULL_FILE_BYTES) return value
  return validationError(
    method,
    field,
    `Expected Uint8Array no larger than ${MAX_FULL_FILE_BYTES} bytes`
  )
}

const requireText = (value: unknown, method: string): string => {
  if (
    typeof value === 'string' &&
    new TextEncoder().encode(value).byteLength <= MAX_TEXT_FILE_BYTES
  ) {
    return value
  }
  return validationError(
    method,
    'content',
    `Expected UTF-8 text no larger than ${MAX_TEXT_FILE_BYTES} bytes`
  )
}

const validatePruneAutoSaveProjectsReq = (value: unknown): PruneAutoSaveProjectsReq => {
  const method = 'pruneAutoSaveProjects'
  const req = requireRecord(value, method)
  const currentProjectDirName = requireNonEmptyString(
    req.currentProjectDirName,
    method,
    'currentProjectDirName'
  )
  if (
    currentProjectDirName.includes('/') ||
    currentProjectDirName.includes(String.fromCharCode(92))
  ) {
    throw new ServiceValidationError(method, undefined, [
      { path: ['currentProjectDirName'], message: 'Expected a directory basename' }
    ])
  }
  const maxProjects = req.maxProjects
  if (
    typeof maxProjects !== 'number' ||
    !Number.isInteger(maxProjects) ||
    maxProjects < 1 ||
    maxProjects > 100
  ) {
    throw new ServiceValidationError(method, undefined, [
      { path: ['maxProjects'], message: 'Expected an integer from 1 to 100' }
    ])
  }
  return { currentProjectDirName, maxProjects }
}

const validatePathReq =
  <T extends { fullPath: string }>(method: string) =>
  (value: unknown): T => {
    const req = requireRecord(value, method)
    return { fullPath: requireNonEmptyString(req.fullPath, method, 'fullPath') } as T
  }

const validateImageWriteReq =
  (method: string) =>
  (value: unknown): SaveImageToPathReq => {
    const req = requireRecord(value, method)
    return {
      image: requireUint8Array(req.image, method, 'image'),
      outputPath: requireNonEmptyString(req.outputPath, method, 'outputPath'),
      filename: requireBasename(req.filename, method)
    }
  }

const validateSaveQAppInputImageReq = (value: unknown): SaveQAppInputImageReq => {
  const method = 'saveQAppInputImage'
  const req = requireRecord(value, method)
  return {
    image: requireUint8Array(req.image, method, 'image'),
    filename: requireBasename(req.filename, method)
  }
}

const validateWriteTextFileReq = (value: unknown): WriteTextFileReq => {
  const method = 'writeTextFile'
  const req = requireRecord(value, method)
  return {
    outputPath: requireNonEmptyString(req.outputPath, method, 'outputPath'),
    filename: requireBasename(req.filename, method),
    content: requireText(req.content, method)
  }
}

const requireRelativePath = (value: unknown, method: string, field: string): string => {
  const relativePath = requireNonEmptyString(value, method, field).replace(/\\/g, '/')
  const segments = relativePath.split('/')
  if (
    relativePath.startsWith('/') ||
    /^[a-zA-Z]:/.test(relativePath) ||
    segments.some(
      (segment) => !segment || segment === '.' || segment === '..' || segment.includes('\0')
    )
  ) {
    return validationError(method, field, 'Expected a safe relative path without traversal')
  }
  return relativePath
}

const validateSourceRootReq =
  <T extends { sourceRoot: string }>(method: string) =>
  (value: unknown): T => {
    const req = requireRecord(value, method)
    return { sourceRoot: requireNonEmptyString(req.sourceRoot, method, 'sourceRoot') } as T
  }

const validatePrepareBatchWorkspaceReq = (value: unknown): PrepareBatchWorkspaceReq => {
  const method = 'prepareBatchWorkspace'
  const req = requireRecord(value, method)
  if (req.userAuthorized !== true) {
    return validationError(method, 'userAuthorized', 'Expected explicit user authorization')
  }
  return {
    sourceRoot: requireNonEmptyString(req.sourceRoot, method, 'sourceRoot'),
    userAuthorized: true
  }
}

const validateWriteBatchManifestReq = (value: unknown): WriteBatchManifestReq => {
  const method = 'writeBatchManifest'
  const req = requireRecord(value, method)
  if (!isRecord(req.manifest) || req.manifest.version !== BATCH_MANIFEST_VERSION) {
    return validationError(
      method,
      'manifest',
      `Expected batch manifest version ${BATCH_MANIFEST_VERSION}`
    )
  }
  return {
    sourceRoot: requireNonEmptyString(req.sourceRoot, method, 'sourceRoot'),
    manifest: req.manifest as BatchManifest
  }
}

const validateBatchSourceFingerprint = (value: unknown, method: string): BatchSourceFingerprint => {
  const fingerprint = requireRecord(value, method)
  const size = fingerprint.size
  const mtimeMs = fingerprint.mtimeMs
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0)
    return validationError(method, 'sourceFingerprint.size', 'Expected a non-negative integer')
  if (typeof mtimeMs !== 'number' || !Number.isFinite(mtimeMs) || mtimeMs < 0)
    return validationError(method, 'sourceFingerprint.mtimeMs', 'Expected a non-negative number')
  return { size, mtimeMs }
}

const validateReadBatchSourceImageReq = (value: unknown): ReadBatchSourceImageReq => {
  const method = 'readBatchSourceImage'
  const req = requireRecord(value, method)
  return {
    sourceRoot: requireNonEmptyString(req.sourceRoot, method, 'sourceRoot'),
    relativeInputPath: requireRelativePath(req.relativeInputPath, method, 'relativeInputPath'),
    sourceFingerprint: validateBatchSourceFingerprint(req.sourceFingerprint, method)
  }
}

const validateCommitBatchPngReq = (value: unknown): CommitBatchPngReq => {
  const method = 'commitBatchPng'
  const req = requireRecord(value, method)
  return {
    sourceRoot: requireNonEmptyString(req.sourceRoot, method, 'sourceRoot'),
    relativeInputPath: requireRelativePath(req.relativeInputPath, method, 'relativeInputPath'),
    sourceFingerprint: validateBatchSourceFingerprint(req.sourceFingerprint, method),
    image: requireUint8Array(req.image, method, 'image')
  }
}

const validateRemoveBatchStagingArtifactsReq = (value: unknown): RemoveBatchStagingArtifactsReq => {
  const method = 'removeBatchStagingArtifacts'
  const req = requireRecord(value, method)
  return {
    sourceRoot: requireNonEmptyString(req.sourceRoot, method, 'sourceRoot'),
    relativeInputPath: requireRelativePath(req.relativeInputPath, method, 'relativeInputPath')
  }
}

const validateFailBatchItemReq = (value: unknown): FailBatchItemReq => {
  const method = 'failBatchItem'
  const req = requireRecord(value, method)
  return {
    sourceRoot: requireNonEmptyString(req.sourceRoot, method, 'sourceRoot'),
    relativeInputPath: requireRelativePath(req.relativeInputPath, method, 'relativeInputPath'),
    errorLog: requireNonEmptyString(req.errorLog, method, 'errorLog')
  }
}

const validateReadFileSliceReq = (value: unknown): ReadFileSliceReq => {
  const method = 'readFileSlice'
  const req = requireRecord(value, method)
  const requireInteger = (field: 'offset' | 'length', min: number, max: number): number => {
    const input = req[field]
    if (typeof input === 'number' && Number.isSafeInteger(input) && input >= min && input <= max) {
      return input
    }
    return validationError(method, field, `Expected an integer between ${min} and ${max}`)
  }
  return {
    fullPath: requireNonEmptyString(req.fullPath, method, 'fullPath'),
    offset: req.offset === undefined ? 0 : requireInteger('offset', 0, Number.MAX_SAFE_INTEGER),
    length: requireInteger('length', 1, MAX_READ_FILE_SLICE_BYTES)
  }
}

export type FsSvc = {
  listImagesInFolder(req: ListImagesInFolderReq): Promise<ListImagesInFolderResp>
  listFilesInFolder(req: ListFilesInFolderReq): Promise<ListFilesInFolderResp>
  pruneAutoSaveProjects(req: PruneAutoSaveProjectsReq): Promise<PruneAutoSaveProjectsResp>
  saveImageToPath(req: SaveImageToPathReq): Promise<SaveImageToPathResp>
  saveQAppInputImage(req: SaveQAppInputImageReq): Promise<SaveQAppInputImageResp>
  readImageFromPath(req: ReadImageFromPathReq): Promise<ReadImageFromPathResp>
  readTextFile(req: ReadTextFileReq): Promise<ReadTextFileResp>
  readFileFromPath(req: ReadFileFromPathReq): Promise<ReadFileFromPathResp>
  readFileSlice(req: ReadFileSliceReq): Promise<ReadFileSliceResp>
  writeTextFile(req: WriteTextFileReq): Promise<WriteTextFileResp>
  scanBatchImages(req: ScanBatchImagesReq): Promise<ScanBatchImagesResp>
  prepareBatchWorkspace(req: PrepareBatchWorkspaceReq): Promise<PrepareBatchWorkspaceResp>
  readBatchManifest(req: ReadBatchManifestReq): Promise<ReadBatchManifestResp>
  writeBatchManifest(req: WriteBatchManifestReq): Promise<WriteBatchManifestResp>
  readBatchSourceImage(req: ReadBatchSourceImageReq): Promise<ReadBatchSourceImageResp>
  commitBatchPng(req: CommitBatchPngReq): Promise<CommitBatchPngResp>
  removeBatchStagingArtifacts(
    req: RemoveBatchStagingArtifactsReq
  ): Promise<RemoveBatchStagingArtifactsResp>
  failBatchItem(req: FailBatchItemReq): Promise<FailBatchItemResp>
  readLoraTriggerWordsNative(
    req: ReadLoraTriggerWordsNativeReq
  ): Promise<ReadLoraTriggerWordsNativeResp>
}

export const fsSvcDef: ServiceDefSheet<FsSvc> = {
  listImagesInFolder: {
    type: 'unary'
  },
  listFilesInFolder: {
    type: 'unary'
  },
  pruneAutoSaveProjects: {
    type: 'unary',
    request: validatePruneAutoSaveProjectsReq
  },
  saveImageToPath: {
    type: 'unary',
    request: validateImageWriteReq('saveImageToPath')
  },
  saveQAppInputImage: {
    type: 'unary',
    request: validateSaveQAppInputImageReq
  },
  readImageFromPath: {
    type: 'unary',
    request: validatePathReq<ReadImageFromPathReq>('readImageFromPath')
  },
  readTextFile: {
    type: 'unary',
    request: validatePathReq<ReadTextFileReq>('readTextFile')
  },
  readFileFromPath: {
    type: 'unary',
    request: validatePathReq<ReadFileFromPathReq>('readFileFromPath')
  },
  readFileSlice: {
    type: 'unary',
    request: validateReadFileSliceReq
  },
  writeTextFile: {
    type: 'unary',
    request: validateWriteTextFileReq
  },
  scanBatchImages: {
    type: 'unary',
    request: validateSourceRootReq<ScanBatchImagesReq>('scanBatchImages')
  },
  prepareBatchWorkspace: {
    type: 'unary',
    request: validatePrepareBatchWorkspaceReq
  },
  readBatchManifest: {
    type: 'unary',
    request: validateSourceRootReq<ReadBatchManifestReq>('readBatchManifest')
  },
  writeBatchManifest: {
    type: 'unary',
    request: validateWriteBatchManifestReq
  },
  readBatchSourceImage: {
    type: 'unary',
    request: validateReadBatchSourceImageReq
  },
  commitBatchPng: {
    type: 'unary',
    request: validateCommitBatchPngReq
  },
  removeBatchStagingArtifacts: {
    type: 'unary',
    request: validateRemoveBatchStagingArtifactsReq
  },
  failBatchItem: {
    type: 'unary',
    request: validateFailBatchItemReq
  },
  readLoraTriggerWordsNative: {
    type: 'unary'
  }
}
