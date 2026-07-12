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

export const MAX_READ_FILE_SLICE_BYTES = 16 * 1024 * 1024
export const MAX_FULL_FILE_BYTES = 64 * 1024 * 1024
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
  saveImageToPath(req: SaveImageToPathReq): Promise<SaveImageToPathResp>
  saveQAppInputImage(req: SaveQAppInputImageReq): Promise<SaveQAppInputImageResp>
  readImageFromPath(req: ReadImageFromPathReq): Promise<ReadImageFromPathResp>
  readTextFile(req: ReadTextFileReq): Promise<ReadTextFileResp>
  readFileFromPath(req: ReadFileFromPathReq): Promise<ReadFileFromPathResp>
  readFileSlice(req: ReadFileSliceReq): Promise<ReadFileSliceResp>
  writeTextFile(req: WriteTextFileReq): Promise<WriteTextFileResp>
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
  readLoraTriggerWordsNative: {
    type: 'unary'
  }
}
