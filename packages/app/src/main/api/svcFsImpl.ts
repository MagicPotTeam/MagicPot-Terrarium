import {
  FsSvc,
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
import * as fs from 'fs'
import * as path from 'path'

const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.tif', '.tiff']

function normalizeExtension(value: string): string {
  const normalized = value.trim().toLowerCase()
  return normalized.startsWith('.') ? normalized : `.${normalized}`
}

export class FsSvcImpl implements FsSvc {
  listImagesInFolder = async (req: ListImagesInFolderReq): Promise<ListImagesInFolderResp> => {
    const { folderPath } = req

    if (!fs.existsSync(folderPath)) {
      return { images: [] }
    }

    const files = fs.readdirSync(folderPath)
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

    if (!fs.existsSync(folderPath)) {
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

      const entries = fs.readdirSync(currentDir, { withFileTypes: true })
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

        const stats = fs.statSync(fullPath)
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
    if (!fs.existsSync(outputPath)) {
      fs.mkdirSync(outputPath, { recursive: true })
    }

    const fullPath = path.join(outputPath, filename)
    fs.writeFileSync(fullPath, Buffer.from(image))

    return { success: true, fullPath }
  }

  readImageFromPath = async (req: ReadImageFromPathReq): Promise<ReadImageFromPathResp> => {
    const { fullPath } = req

    if (!fs.existsSync(fullPath)) {
      throw new Error(`File not found: ${fullPath}`)
    }

    const buffer = fs.readFileSync(fullPath)
    const filename = path.basename(fullPath)

    return {
      image: new Uint8Array(buffer),
      filename
    }
  }

  readTextFile = async (req: ReadTextFileReq): Promise<ReadTextFileResp> => {
    const { fullPath } = req

    if (!fs.existsSync(fullPath)) {
      throw new Error(`File not found: ${fullPath}`)
    }

    return {
      content: fs.readFileSync(fullPath, 'utf8'),
      filename: path.basename(fullPath)
    }
  }

  readFileFromPath = async (req: ReadFileFromPathReq): Promise<ReadFileFromPathResp> => {
    const { fullPath } = req

    if (!fs.existsSync(fullPath)) {
      throw new Error(`File not found: ${fullPath}`)
    }

    const buffer = fs.readFileSync(fullPath)
    return {
      data: new Uint8Array(buffer),
      filename: path.basename(fullPath)
    }
  }

  readFileSlice = async (req: ReadFileSliceReq): Promise<ReadFileSliceResp> => {
    const { fullPath, length } = req
    const offset = Math.max(0, Math.floor(req.offset || 0))
    const safeLength = Math.max(0, Math.floor(length))

    if (!fs.existsSync(fullPath)) {
      throw new Error(`File not found: ${fullPath}`)
    }

    const stats = fs.statSync(fullPath)
    if (!stats.isFile()) {
      throw new Error(`Path is not a file: ${fullPath}`)
    }

    if (safeLength === 0 || offset >= stats.size) {
      return {
        data: new Uint8Array(),
        filename: path.basename(fullPath),
        fileSizeBytes: stats.size
      }
    }

    const bytesToRead = Math.min(safeLength, stats.size - offset)
    const fd = fs.openSync(fullPath, 'r')
    try {
      const buffer = Buffer.alloc(bytesToRead)
      const bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, offset)
      return {
        data: new Uint8Array(buffer.subarray(0, bytesRead)),
        filename: path.basename(fullPath),
        fileSizeBytes: stats.size
      }
    } finally {
      fs.closeSync(fd)
    }
  }

  writeTextFile = async (req: WriteTextFileReq): Promise<WriteTextFileResp> => {
    const { outputPath, filename, content } = req

    if (!fs.existsSync(outputPath)) {
      fs.mkdirSync(outputPath, { recursive: true })
    }

    const fullPath = path.join(outputPath, filename)
    fs.writeFileSync(fullPath, content, 'utf8')

    return {
      success: true,
      fullPath
    }
  }
}
