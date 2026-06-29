import {
  FsSvc,
  MAX_READ_FILE_SLICE_BYTES,
  ListFilesInFolderReq,
  ListFilesInFolderResp,
  ListImagesInFolderReq,
  ListImagesInFolderResp,
  SaveImageToPathReq,
  SaveImageToPathResp,
  SaveQAppInputImageReq,
  SaveQAppInputImageResp,
  ReadImageFromPathReq,
  ReadImageFromPathResp,
  ReadFileFromPathReq,
  ReadFileFromPathResp,
  ReadFileSliceReq,
  ReadFileSliceResp,
  ReadLoraTriggerWordsNativeReq,
  ReadLoraTriggerWordsNativeResp,
  ReadTextFileReq,
  ReadTextFileResp,
  WriteTextFileReq,
  WriteTextFileResp
} from '@shared/api/svcFs'
import fs from 'fs/promises'
import * as path from 'path'
import { app } from 'electron'
import { execFile } from 'child_process'
import { promisify } from 'util'

const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.tif', '.tiff']
const MAX_CONCURRENT_FS_OPS = 16
const QAPP_INPUT_IMAGE_DIR = 'qapp-input-images'
const LORA_TRIGGER_SIDECAR_EXE =
  process.platform === 'win32' ? 'lora-trigger-sidecar.exe' : 'lora-trigger-sidecar'
const LORA_TRIGGER_SIDECAR_TIMEOUT_MS = 1500
const execFileAsync = promisify(execFile)

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

const getLoraTriggerSidecarCandidates = (): string[] => {
  const appPath = typeof app?.getAppPath === 'function' ? app.getAppPath() : process.cwd()
  const resourcesPath = process.resourcesPath || process.cwd()
  const candidatePaths = [
    path.join(resourcesPath, 'bin', 'lora-trigger-sidecar', LORA_TRIGGER_SIDECAR_EXE),
    path.join(
      resourcesPath,
      'packages',
      'runtime-assets',
      'resources',
      'bin',
      'lora-trigger-sidecar',
      LORA_TRIGGER_SIDECAR_EXE
    ),
    path.join(
      appPath,
      'packages',
      'runtime-assets',
      'resources',
      'bin',
      'lora-trigger-sidecar',
      LORA_TRIGGER_SIDECAR_EXE
    ),
    path.join(
      appPath,
      '..',
      'packages',
      'runtime-assets',
      'resources',
      'bin',
      'lora-trigger-sidecar',
      LORA_TRIGGER_SIDECAR_EXE
    ),
    path.join(
      process.cwd(),
      'packages',
      'runtime-assets',
      'resources',
      'bin',
      'lora-trigger-sidecar',
      LORA_TRIGGER_SIDECAR_EXE
    )
  ]

  return Array.from(new Set(candidatePaths.map((candidatePath) => path.normalize(candidatePath))))
}

const resolveLoraTriggerSidecarPath = async (): Promise<string | null> => {
  for (const candidatePath of getLoraTriggerSidecarCandidates()) {
    if (await pathExists(candidatePath)) {
      return candidatePath
    }
  }
  return null
}

const sanitizeFileName = (value: string): string => {
  const normalized = path.basename(String(value || '').trim())
  const withoutReservedChars = normalized.replace(/[<>:"/\\|?*]+/g, '_')
  const withoutControlChars = Array.from(withoutReservedChars)
    .map((char) => (char.charCodeAt(0) < 32 ? '_' : char))
    .join('')
    .trim()
  return withoutControlChars || 'qapp-input-image.png'
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

  saveQAppInputImage = async (req: SaveQAppInputImageReq): Promise<SaveQAppInputImageResp> => {
    const outputPath = path.join(app.getPath('userData'), QAPP_INPUT_IMAGE_DIR)
    await runBoundedFsOp(() => fs.mkdir(outputPath, { recursive: true }))

    const safeName = sanitizeFileName(req.filename)
    const extension = path.extname(safeName)
    const baseName = extension ? safeName.slice(0, -extension.length) : safeName
    const filename = `${baseName}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${extension || '.png'}`
    const fullPath = path.join(outputPath, filename)
    await runBoundedFsOp(() => fs.writeFile(fullPath, Buffer.from(req.image)))

    return { success: true, fullPath, filename }
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

  readLoraTriggerWordsNative = async (
    req: ReadLoraTriggerWordsNativeReq
  ): Promise<ReadLoraTriggerWordsNativeResp> => {
    const loraDir = req.loraDir.trim()
    const loraName = req.loraName.trim()
    if (!loraDir || !loraName) {
      return { triggerWords: '', source: '', nativeAvailable: false }
    }

    const sidecarPath = await resolveLoraTriggerSidecarPath()
    if (!sidecarPath) {
      return { triggerWords: '', source: '', nativeAvailable: false }
    }

    const { stdout } = await execFileAsync(
      sidecarPath,
      ['--lora-dir', loraDir, '--lora-name', loraName],
      {
        timeout: LORA_TRIGGER_SIDECAR_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 1024 * 1024
      }
    )
    const parsed = JSON.parse(stdout.trim() || '{}') as Partial<{
      trigger_words: unknown
      source: unknown
    }>

    return {
      triggerWords: typeof parsed.trigger_words === 'string' ? parsed.trigger_words : '',
      source: typeof parsed.source === 'string' ? parsed.source : '',
      nativeAvailable: true
    }
  }
}
