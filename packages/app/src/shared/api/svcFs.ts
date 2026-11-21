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
  /** The scan stopped at MAX_LISTED_FOLDER_ENTRIES entries: the list is not complete. */
  truncated?: boolean
}

/** A listing looks at no more entries (files and folders, across every level) than this. */
export const MAX_LISTED_FOLDER_ENTRIES = 100_000

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
  /** Optional caller budget; cannot exceed the full-file IPC limit. */
  maxBytes?: number
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

/** A file a skill names as one of its resources (see FsSvc.readSkillResourceFile). */
export type ReadSkillResourceFileReq = {
  fullPath: string
}

export type ReadSkillResourceFileResp = ReadTextFileResp

/**
 * The mark of a read of a path the renderer named whose answer main does not know now: the
 * filesystem did not answer in time or failed, or every slot was held by calls that did not.
 * Such a file may well exist, so its error never says "File not found".
 */
export const LOCAL_FILE_UNAVAILABLE_ERROR = 'LOCAL_FILE_UNAVAILABLE'

export const formatLocalFileUnavailableMessage = (fullPath: string): string =>
  `${LOCAL_FILE_UNAVAILABLE_ERROR}: the local file did not answer and may still exist: ${fullPath}`

export const isLocalFileUnavailableError = (error: unknown): boolean =>
  error instanceof Error && error.message.includes(LOCAL_FILE_UNAVAILABLE_ERROR)

/**
 * A read refused because the file is not there: "File not found", and never an unavailable
 * one, whatever the path in its message spells.
 */
export const isLocalFileNotFoundError = (error: unknown): boolean =>
  error instanceof Error &&
  !isLocalFileUnavailableError(error) &&
  /file not found/i.test(error.message)

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

// ─── Canvas autosave mirror assets ───────────────────────────────────────────
// Content-addressed copies of the binaries of one board. The destination is
// never chosen by the caller: main resolves it to
// <autoSaveRoot>/<projectDirName>/assets/<assetFileName>.
export const CANVAS_MIRROR_ASSET_KEY_PATTERN = /^[bfu]-[0-9a-f]{40}$/
export const CANVAS_MIRROR_ASSET_FILE_NAME_PATTERN = /^[bfu]-[0-9a-f]{40}(?:\.[a-z0-9]{1,16})?$/
export const MAX_CANVAS_MIRROR_KEEP_ENTRIES = 200_000
export const MAX_CANVAS_MIRROR_SOURCE_PATH_LENGTH = 4096

export type CanvasMirrorAssetResp = {
  /**
   * 'written': the file was created by this call; 'exists': it was already there and was kept;
   * 'no-space': nothing was written because the volume cannot hold the asset besides the
   * copies already in flight and a safety margin (sizeBytes is then the asset's size).
   * A 'no-space' result is final for the save that asked: it must not send the same bytes again.
   */
  status: 'written' | 'exists' | 'no-space'
  sizeBytes: number
}

export type CopyCanvasMirrorAssetReq = {
  projectDirName: string
  assetFileName: string
  /** Absolute path of a file the renderer is authorized to read. */
  sourcePath: string
}

export type WriteCanvasMirrorAssetReq = {
  projectDirName: string
  assetFileName: string
  data: Uint8Array
}

export type ListCanvasMirrorAssetsReq = {
  projectDirName: string
}

export type ListCanvasMirrorAssetsResp = {
  assetFileNames: string[]
}

export type PruneCanvasMirrorAssetsReq = {
  projectDirName: string
  /** Content keys to keep although the stored project file does not reference them. */
  keepAssetKeys: string[]
  /** Names of entries directly under assets/ (files or snapshot folders) to keep as well. */
  keepEntryNames: string[]
}

export type PruneCanvasMirrorAssetsResp = {
  removedAssetFileNames: string[]
  removedSnapshotDirNames: string[]
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

const validateReadImageFromPathReq = (value: unknown): ReadImageFromPathReq => {
  const method = 'readImageFromPath'
  const req = requireRecord(value, method)
  const fullPath = requireNonEmptyString(req.fullPath, method, 'fullPath')
  if (req.maxBytes === undefined) return { fullPath }
  if (
    typeof req.maxBytes !== 'number' ||
    !Number.isSafeInteger(req.maxBytes) ||
    req.maxBytes < 1 ||
    req.maxBytes > MAX_FULL_FILE_BYTES
  ) {
    return validationError(
      method,
      'maxBytes',
      `Expected an integer between 1 and ${MAX_FULL_FILE_BYTES}`
    )
  }
  return { fullPath, maxBytes: req.maxBytes }
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

const requireCanvasMirrorProjectDirName = (value: unknown, method: string): string => {
  const name = requireNonEmptyString(value, method, 'projectDirName')
  if (
    name.length > MAX_FILENAME_LENGTH ||
    name !== name.trim() ||
    name === '.' ||
    name === '..' ||
    name.includes('/') ||
    name.includes('\\') ||
    name.includes('\0') ||
    name.includes(':')
  ) {
    return validationError(method, 'projectDirName', 'Expected a directory basename')
  }
  return name
}

const requireCanvasMirrorAssetFileName = (value: unknown, method: string): string => {
  if (typeof value === 'string' && CANVAS_MIRROR_ASSET_FILE_NAME_PATTERN.test(value)) return value
  return validationError(method, 'assetFileName', 'Expected a content-keyed asset file name')
}

const validateCopyCanvasMirrorAssetReq = (value: unknown): CopyCanvasMirrorAssetReq => {
  const method = 'copyCanvasMirrorAsset'
  const req = requireRecord(value, method)
  const sourcePath = requireNonEmptyString(req.sourcePath, method, 'sourcePath')
  if (sourcePath.length > MAX_CANVAS_MIRROR_SOURCE_PATH_LENGTH || sourcePath.includes('\0')) {
    return validationError(method, 'sourcePath', 'Expected an absolute file path')
  }
  return {
    projectDirName: requireCanvasMirrorProjectDirName(req.projectDirName, method),
    assetFileName: requireCanvasMirrorAssetFileName(req.assetFileName, method),
    sourcePath
  }
}

const validateWriteCanvasMirrorAssetReq = (value: unknown): WriteCanvasMirrorAssetReq => {
  const method = 'writeCanvasMirrorAsset'
  const req = requireRecord(value, method)
  return {
    projectDirName: requireCanvasMirrorProjectDirName(req.projectDirName, method),
    assetFileName: requireCanvasMirrorAssetFileName(req.assetFileName, method),
    data: requireUint8Array(req.data, method, 'data')
  }
}

const validateListCanvasMirrorAssetsReq = (value: unknown): ListCanvasMirrorAssetsReq => {
  const method = 'listCanvasMirrorAssets'
  const req = requireRecord(value, method)
  return { projectDirName: requireCanvasMirrorProjectDirName(req.projectDirName, method) }
}

const validatePruneCanvasMirrorAssetsReq = (value: unknown): PruneCanvasMirrorAssetsReq => {
  const method = 'pruneCanvasMirrorAssets'
  const req = requireRecord(value, method)
  const requireList = (
    field: 'keepAssetKeys' | 'keepEntryNames',
    isValid: (entry: string) => boolean
  ): string[] => {
    const input = req[field]
    if (
      Array.isArray(input) &&
      input.length <= MAX_CANVAS_MIRROR_KEEP_ENTRIES &&
      input.every((entry) => typeof entry === 'string' && isValid(entry))
    ) {
      return input as string[]
    }
    return validationError(method, field, 'Expected a bounded list of valid names')
  }
  return {
    projectDirName: requireCanvasMirrorProjectDirName(req.projectDirName, method),
    keepAssetKeys: requireList('keepAssetKeys', (entry) =>
      CANVAS_MIRROR_ASSET_KEY_PATTERN.test(entry)
    ),
    keepEntryNames: requireList(
      'keepEntryNames',
      (entry) =>
        entry.length > 0 &&
        entry.length <= MAX_FILENAME_LENGTH &&
        entry !== '.' &&
        entry !== '..' &&
        !/[\\/\0]/.test(entry)
    )
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
  /**
   * A skill resource: only under the custom skill folder of the app's data, or a file the user
   * granted; never the app's other data (its config, grants, chats) nor a skill definition.
   */
  readSkillResourceFile(req: ReadSkillResourceFileReq): Promise<ReadSkillResourceFileResp>
  readFileFromPath(req: ReadFileFromPathReq): Promise<ReadFileFromPathResp>
  readFileSlice(req: ReadFileSliceReq): Promise<ReadFileSliceResp>
  writeTextFile(req: WriteTextFileReq): Promise<WriteTextFileResp>
  copyCanvasMirrorAsset(req: CopyCanvasMirrorAssetReq): Promise<CanvasMirrorAssetResp>
  writeCanvasMirrorAsset(req: WriteCanvasMirrorAssetReq): Promise<CanvasMirrorAssetResp>
  listCanvasMirrorAssets(req: ListCanvasMirrorAssetsReq): Promise<ListCanvasMirrorAssetsResp>
  pruneCanvasMirrorAssets(req: PruneCanvasMirrorAssetsReq): Promise<PruneCanvasMirrorAssetsResp>
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
    request: validateReadImageFromPathReq
  },
  readTextFile: {
    type: 'unary',
    request: validatePathReq<ReadTextFileReq>('readTextFile')
  },
  readSkillResourceFile: {
    type: 'unary',
    request: validatePathReq<ReadSkillResourceFileReq>('readSkillResourceFile')
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
  copyCanvasMirrorAsset: {
    type: 'unary',
    request: validateCopyCanvasMirrorAssetReq
  },
  writeCanvasMirrorAsset: {
    type: 'unary',
    request: validateWriteCanvasMirrorAssetReq
  },
  listCanvasMirrorAssets: {
    type: 'unary',
    request: validateListCanvasMirrorAssetsReq
  },
  pruneCanvasMirrorAssets: {
    type: 'unary',
    request: validatePruneCanvasMirrorAssetsReq
  },
  readLoraTriggerWordsNative: {
    type: 'unary'
  }
}
