import { ServiceDefSheet } from './apiUtils/serviceDefSheet'

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

export type WriteTextFileReq = {
  outputPath: string
  filename: string
  content: string
}

export type WriteTextFileResp = {
  success: boolean
  fullPath: string
}

export type FsSvc = {
  listImagesInFolder(req: ListImagesInFolderReq): Promise<ListImagesInFolderResp>
  listFilesInFolder(req: ListFilesInFolderReq): Promise<ListFilesInFolderResp>
  saveImageToPath(req: SaveImageToPathReq): Promise<SaveImageToPathResp>
  readImageFromPath(req: ReadImageFromPathReq): Promise<ReadImageFromPathResp>
  readTextFile(req: ReadTextFileReq): Promise<ReadTextFileResp>
  readFileFromPath(req: ReadFileFromPathReq): Promise<ReadFileFromPathResp>
  writeTextFile(req: WriteTextFileReq): Promise<WriteTextFileResp>
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
  readImageFromPath: {
    type: 'unary'
  },
  readTextFile: {
    type: 'unary'
  },
  readFileFromPath: {
    type: 'unary'
  },
  writeTextFile: {
    type: 'unary'
  }
}
