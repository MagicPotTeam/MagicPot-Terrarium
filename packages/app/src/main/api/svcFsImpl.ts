import {
  FsSvc,
  MAX_READ_FILE_SLICE_BYTES,
  ListFilesInFolderReq,
  ListFilesInFolderResp,
  ListImagesInFolderReq,
  ListImagesInFolderResp,
  SaveImageToPathReq,
  SaveImageToPathResp,
  ReadImageFromPathReq,
  ReadImageFromPathResp,
  ReadFileFromPathReq,
  ReadFileFromPathResp,
  ReadFileSliceReq,
  ReadFileSliceResp,
  ReadTextFileReq,
  ReadTextFileResp,
  WriteTextFileReq,
  WriteTextFileResp
} from '@shared/api/svcFs'
import fs from 'fs/promises'
import * as path from 'path'

const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.tif', '.tiff']
const MAX_CONCURRENT_FS_OPS = 16

let activeFsOps = 0
const pendingFsOps: (() => void)[] = []

const acquireFsOpSlot = async (): Promise<void> =>
  new Promise((resolve) => {
    const acquire = (): void => {
      activeFsOps += 1
      resolve()
    }

    if (activeFsOps < MAX_CONCURRENT_FS_OPS) {
      acquire()
      return
    }

    pendingFsOps.push(acquire)
  })

const releaseFsOpSlot = (): void => {
  activeFsOps -= 1
  const next = pendingFsOps.shift()
  if (next && activeFsOps < MAX_CONCURRENT_FS_OPS) {
    next()
  }
}

const runBoundedFsOp = async <T>(operation: () => Promise<T>): Promise<T> => {
  await acquireFsOpSlot()
  try {
    return await operation()
  } finally {
    releaseFsOpSlot()
  }
}

const pathExists = async (targetPath: string): Promise<boolean> => {
  try {
    await runBoundedFsOp(() => fs.access(targetPath))
    return true
  } catch {
    return false
  }
}

function normalizeExtension(value: string): string {
  const normalized = value.trim().toLowerCase()
  return normalized.startsWith('.') ? normalized : `.${normalized}`
}

export class FsSvcImpl implements FsSvc {
  listImagesInFolder = async (req: ListImagesInFolderReq): Promise<ListImagesInFolderResp> => {
    const { folderPath } = req

    if (!(await pathExists(folderPath))) {
      return { images: [] }
    }

    const files = await runBoundedFsOp(() => fs.readdir(folderPath))
    const images = files
      .filter((file) => {
        const ext = path.extname(file).toLowerCase()
        return IMAGE_EXTENSIONS.includes(ext)
      })
      .map((filename) => ({
        filename,
        fullPath: path.join(folderPath, filename)
      }))

    return { images }
  }

  listFilesInFolder = async (req: ListFilesInFolderReq): Promise<ListFilesInFolderResp> => {
    const { folderPath, extensions, recursive = false } = req

    if (!(await pathExists(folderPath))) {
      return { files: [] }
    }

    const normalizedExtensions =
      extensions
        ?.map((value) => value.trim().toLowerCase())
        .filter((value) => value.length > 0)
        .map(normalizeExtension) ?? []

    const directoriesToScan = [folderPath]
    const files: ListFilesInFolderResp['files'] = []

    while (directoriesToScan.length > 0) {
      const currentDir = directoriesToScan.shift()
      if (!currentDir) {
        continue
      }

      const entries = await runBoundedFsOp(() => fs.readdir(currentDir, { withFileTypes: true }))
      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name)

        if (entry.isDirectory()) {
          if (recursive) {
            directoriesToScan.push(fullPath)
          }
          continue
        }

        if (!entry.isFile()) {
          continue
        }

        if (
          normalizedExtensions.length > 0 &&
          !normalizedExtensions.includes(path.extname(entry.name).toLowerCase())
        ) {
          continue
        }

        const stats = await runBoundedFsOp(() => fs.stat(fullPath))
        files.push({
          filename: entry.name,
          fullPath,
          lastModifiedMs: stats.mtimeMs
        })
      }
    }

    return { files }
  }

  saveImageToPath = async (req: SaveImageToPathReq): Promise<SaveImageToPathResp> => {
    const { image, outputPath, filename } = req

    // Ensure output directory exists
    if (!(await pathExists(outputPath))) {
      await runBoundedFsOp(() => fs.mkdir(outputPath, { recursive: true }))
    }

    const fullPath = path.join(outputPath, filename)
    await runBoundedFsOp(() => fs.writeFile(fullPath, Buffer.from(image)))

    return { success: true, fullPath }
  }

  readImageFromPath = async (req: ReadImageFromPathReq): Promise<ReadImageFromPathResp> => {
    const { fullPath } = req

    if (!(await pathExists(fullPath))) {
      throw new Error(`File not found: ${fullPath}`)
    }

    const buffer = await runBoundedFsOp(() => fs.readFile(fullPath))
    const filename = path.basename(fullPath)

    return {
      image: new Uint8Array(buffer),
      filename
    }
  }

  readTextFile = async (req: ReadTextFileReq): Promise<ReadTextFileResp> => {
    const { fullPath } = req

    if (!(await pathExists(fullPath))) {
      throw new Error(`File not found: ${fullPath}`)
    }

    return {
      content: await runBoundedFsOp(() => fs.readFile(fullPath, 'utf8')),
      filename: path.basename(fullPath)
    }
  }

  readFileFromPath = async (req: ReadFileFromPathReq): Promise<ReadFileFromPathResp> => {
    const { fullPath } = req

    if (!(await pathExists(fullPath))) {
      throw new Error(`File not found: ${fullPath}`)
    }

    const buffer = await runBoundedFsOp(() => fs.readFile(fullPath))
    return {
      data: new Uint8Array(buffer),
      filename: path.basename(fullPath)
    }
  }

  readFileSlice = async (req: ReadFileSliceReq): Promise<ReadFileSliceResp> => {
    const { fullPath, length } = req
    const offset = req.offset ?? 0

    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new Error('Invalid file slice offset')
    }
    if (!Number.isSafeInteger(length) || length <= 0 || length > MAX_READ_FILE_SLICE_BYTES) {
      throw new Error(`Invalid file slice length: expected 1-${MAX_READ_FILE_SLICE_BYTES}`)
    }

    if (!(await pathExists(fullPath))) {
      throw new Error(`File not found: ${fullPath}`)
    }

    const stats = await runBoundedFsOp(() => fs.stat(fullPath))
    if (!stats.isFile()) {
      throw new Error(`Path is not a file: ${fullPath}`)
    }

    if (offset >= stats.size) {
      return {
        data: new Uint8Array(),
        filename: path.basename(fullPath),
        fileSizeBytes: stats.size
      }
    }

    const bytesToRead = Math.min(length, stats.size - offset)
    const { buffer, bytesRead } = await runBoundedFsOp(async () => {
      const fd = await fs.open(fullPath, 'r')
      try {
        const buffer = Buffer.alloc(bytesToRead)
        const { bytesRead } = await fd.read(buffer, 0, bytesToRead, offset)
        return { buffer, bytesRead }
      } finally {
        await fd.close()
      }
    })

    return {
      data: new Uint8Array(buffer.subarray(0, bytesRead)),
      filename: path.basename(fullPath),
      fileSizeBytes: stats.size
    }
  }

  writeTextFile = async (req: WriteTextFileReq): Promise<WriteTextFileResp> => {
    const { outputPath, filename, content } = req

    if (!(await pathExists(outputPath))) {
      await runBoundedFsOp(() => fs.mkdir(outputPath, { recursive: true }))
    }

    const fullPath = path.join(outputPath, filename)
    await runBoundedFsOp(() => fs.writeFile(fullPath, content, 'utf8'))

    return {
      success: true,
      fullPath
    }
  }
}
