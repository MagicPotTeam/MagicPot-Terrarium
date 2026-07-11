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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const requireNonEmptyString = (value: unknown, field: string): string => {
  if (typeof value === 'string' && value.trim()) {
    return value
  }
  throw new ServiceValidationError(`svcFs.readFileSlice ${field}`, [
    {
      path: [field],
      message: 'Expected a non-empty string',
      code: 'invalid_type'
    }
  ])
}

const requireBoundedInteger = ({
  value,
  field,
  min,
  max
}: {
  value: unknown
  field: string
  min: number
  max: number
}): number => {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max) {
    return value
  }
  throw new ServiceValidationError(`svcFs.readFileSlice ${field}`, [
    {
      path: [field],
      message: `Expected an integer between ${min} and ${max}`,
      code: 'invalid_type'
    }
  ])
}

const validateReadFileSliceReq = (value: unknown): ReadFileSliceReq => {
  if (!isRecord(value)) {
    throw new ServiceValidationError('svcFs.readFileSlice request')
  }
  return {
    fullPath: requireNonEmptyString(value.fullPath, 'fullPath'),
    offset:
      value.offset === undefined
        ? 0
        : requireBoundedInteger({
            value: value.offset,
            field: 'offset',
            min: 0,
            max: Number.MAX_SAFE_INTEGER
          }),
    length: requireBoundedInteger({
      value: value.length,
      field: 'length',
      min: 1,
      max: MAX_READ_FILE_SLICE_BYTES
    })
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
    type: 'unary'
  },
  saveQAppInputImage: {
    type: 'unary'
  },
  readImageFromPath: {
    type: 'unary'
  },
  readTextFile: {
    type: 'unary'
  },
  readFileFromPath: {
    type: 'unary'
  },
  readFileSlice: {
    type: 'unary',
    request: validateReadFileSliceReq
  },
  writeTextFile: {
    type: 'unary'
  },
  readLoraTriggerWordsNative: {
    type: 'unary'
  }
}
