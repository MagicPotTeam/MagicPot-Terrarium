import {
  CANVAS_MIRROR_ASSET_FILE_NAME_PATTERN,
  CANVAS_MIRROR_ASSET_KEY_PATTERN,
  CanvasMirrorAssetResp,
  CopyCanvasMirrorAssetReq,
  ListCanvasMirrorAssetsReq,
  ListCanvasMirrorAssetsResp,
  PruneCanvasMirrorAssetsReq,
  PruneCanvasMirrorAssetsResp,
  WriteCanvasMirrorAssetReq,
  FsSvc,
  MAX_FILENAME_LENGTH,
  MAX_FULL_FILE_BYTES,
  MAX_READ_FILE_SLICE_BYTES,
  MAX_TEXT_FILE_BYTES,
  ListFilesInFolderReq,
  ListFilesInFolderResp,
  PruneAutoSaveProjectsReq,
  PruneAutoSaveProjectsResp,
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
import fs, { type FileHandle } from 'fs/promises'
import { createReadStream, type Stats } from 'fs'
import * as path from 'path'
import { getCurrentUserDataDirectoryState } from '../config/userDataDirectory'
import { app } from 'electron'
import {
  consumeLocalMediaReadGrant,
  resolveAuthorizedLocalMediaPath,
  type LocalMediaRoot
} from '../localMediaAccess'
import { getVerifiedLocalMediaTempRoots } from '../localMediaAllowedRoots'
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

const requireBasename = (filename: string): string => {
  if (
    typeof filename !== 'string' ||
    !filename.trim() ||
    filename.length > MAX_FILENAME_LENGTH ||
    filename === '.' ||
    filename === '..' ||
    filename.includes('/') ||
    filename.includes('\\') ||
    filename.includes('\0')
  ) {
    throw new Error('Invalid filename: expected a basename-only filename')
  }
  return filename
}

const resolveContainedFile = (directory: string, filename: string): string => {
  const root = path.resolve(directory)
  const fullPath = path.resolve(root, requireBasename(filename))
  const relative = path.relative(root, fullPath)
  if (
    !relative ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error('Invalid filename: resolved path is outside the output directory')
  }
  return fullPath
}

const requireBoundedPayload = (value: Uint8Array, limit: number, label: string): void => {
  if (!(value instanceof Uint8Array) || value.byteLength > limit) {
    throw new Error(`${label} exceeds the ${limit}-byte IPC limit`)
  }
}

const assertReadableFileWithinLimit = async (fullPath: string, limit: number): Promise<number> => {
  const stats = await runBoundedFsOp(() => fs.stat(fullPath))
  if (!stats.isFile()) throw new Error(`Path is not a file: ${fullPath}`)
  if (stats.size > limit) {
    throw new Error(`File exceeds the ${limit}-byte full-file IPC limit; use readFileSlice instead`)
  }
  return stats.size
}

const readImageFileWithinByteBudget = (fullPath: string, maxBytes: number): Promise<Buffer> =>
  runBoundedFsOp(async () => {
    const handle = await fs.open(fullPath, 'r')
    try {
      const stats = await handle.stat()
      if (!stats.isFile()) throw new Error(`Path is not a file: ${fullPath}`)
      if (stats.size > maxBytes) {
        throw new Error(`File exceeds the ${maxBytes}-byte full-file IPC limit`)
      }

      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1))
      const chunks: Buffer[] = []
      let totalBytes = 0
      // One extra byte detects growth without reading an unbounded, changed file.
      while (totalBytes <= maxBytes) {
        const length = Math.min(chunk.byteLength, maxBytes + 1 - totalBytes)
        const { bytesRead } = await handle.read(chunk, 0, length, totalBytes)
        if (bytesRead === 0) break
        totalBytes += bytesRead
        if (totalBytes > maxBytes) {
          throw new Error(`Image exceeds the ${maxBytes}-byte IPC limit`)
        }
        chunks.push(Buffer.from(chunk.subarray(0, bytesRead)))
      }
      return Buffer.concat(chunks, totalBytes)
    } finally {
      await handle.close()
    }
  })

function normalizeExtension(value: string): string {
  const normalized = value.trim().toLowerCase()
  return normalized.startsWith('.') ? normalized : `.${normalized}`
}

// ─── Canvas autosave mirror assets ───────────────────────────────────────────
const CANVAS_MIRROR_ASSET_DIRNAME = 'assets'
const CANVAS_MIRROR_CANVAS_FILENAME = 'project.mpcanvas'
const CANVAS_MIRROR_SNAPSHOT_DIR_PATTERN =
  /^snapshot-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CANVAS_MIRROR_TEMP_FILE_PATTERN =
  /^\.[bfu]-[0-9a-f]{40}(?:\.[a-z0-9]{1,16})?\.tmp-\d+-\d+-[0-9a-z]+$/
/** Unreferenced entries younger than this are kept: another window may be about to reference them. */
export const CANVAS_MIRROR_PRUNE_GRACE_MS = 10 * 60 * 1000

const requireCanvasMirrorProjectDirName = (projectDirName: string): string => {
  const name = requireBasename(projectDirName)
  if (name !== name.trim() || name.includes(':')) {
    throw new Error('Invalid canvas mirror project directory name')
  }
  return name
}

const requireCanvasMirrorAssetFileName = (assetFileName: string): string => {
  if (typeof assetFileName !== 'string' || !CANVAS_MIRROR_ASSET_FILE_NAME_PATTERN.test(assetFileName)) {
    throw new Error('Invalid canvas mirror asset file name')
  }
  return assetFileName
}

const lstatOrNull = async (targetPath: string): Promise<Stats | null> => {
  try {
    return await runBoundedFsOp(() => fs.lstat(targetPath))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/**
 * Resolves <autoSaveRoot>/<projectDirName>/assets. Neither the project folder
 * nor the asset folder may be a symbolic link, and the real asset folder must
 * be exactly two levels below the real autosave root. Returns null when the
 * folder does not exist and `create` is false.
 */
const resolveCanvasMirrorAssetDir = async (
  projectDirName: string,
  create: boolean
): Promise<{ projectDir: string; assetDir: string } | null> => {
  const autoSaveRoot = path.resolve(getCurrentUserDataDirectoryState().autoSaveRoot)
  const projectDir = resolveContainedFile(
    autoSaveRoot,
    requireCanvasMirrorProjectDirName(projectDirName)
  )
  const assetDir = path.join(projectDir, CANVAS_MIRROR_ASSET_DIRNAME)

  for (const directory of [projectDir, assetDir]) {
    let stats = await lstatOrNull(directory)
    if (!stats) {
      if (!create) return null
      await runBoundedFsOp(() => fs.mkdir(directory, { recursive: true }))
      stats = await lstatOrNull(directory)
    }
    if (!stats || stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error('Canvas mirror folder is not a plain directory')
    }
  }

  const [realRoot, realAssetDir] = await Promise.all([
    runBoundedFsOp(() => fs.realpath(autoSaveRoot)),
    runBoundedFsOp(() => fs.realpath(assetDir))
  ])
  const relative = path.relative(realRoot, realAssetDir)
  const segments = relative.split(path.sep)
  if (
    path.isAbsolute(relative) ||
    segments.length !== 2 ||
    segments.some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw new Error('Canvas mirror folder is outside the autosave root')
  }
  return { projectDir, assetDir }
}

const canvasMirrorAssetWrites = new Map<string, Promise<CanvasMirrorAssetResp>>()

/**
 * Publishes one content-keyed mirror asset. An existing file is never
 * replaced (the stored project file may reference it), except an empty file
 * left behind by an interrupted write. The bytes go to a temporary file that
 * this process creates itself ('wx', mode 0o644: no mode, read-only attribute
 * or file flag of a source is inherited), is flushed and then linked into
 * place, so a reader never sees a partial file. The temporary file is removed
 * on every path out.
 */
const publishCanvasMirrorAsset = async (
  assetDir: string,
  assetFileName: string,
  sourceSizeBytes: number,
  writeTemp: (handle: FileHandle, wrote: (bytes: number) => void) => Promise<void>
): Promise<CanvasMirrorAssetResp> => {
  const destination = path.join(assetDir, requireCanvasMirrorAssetFileName(assetFileName))
  const previous = canvasMirrorAssetWrites.get(destination)
  const run = async (): Promise<CanvasMirrorAssetResp> => {
    const existing = await lstatOrNull(destination)
    if (existing && (existing.isSymbolicLink() || !existing.isFile())) {
      throw new Error('Canvas mirror asset path is not a regular file')
    }
    const repairEmptyFile = !!existing && existing.size === 0 && sourceSizeBytes > 0
    if (existing && !repairEmptyFile) {
      return { status: 'exists', sizeBytes: existing.size }
    }

    // Only a file that has to be written needs room; the bytes stay reserved until it is
    // published or given up, so copies running at the same time cannot overcommit the volume.
    const space = await reserveCanvasMirrorSpace(assetDir, sourceSizeBytes)
    if (!space) return { status: 'no-space', sizeBytes: sourceSizeBytes }

    const tempPath = path.join(
      assetDir,
      `.${assetFileName}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    )
    try {
      await runBoundedFsOp(async () => {
        const handle = await fs.open(tempPath, 'wx', 0o644)
        try {
          await writeTemp(handle, space.wrote)
          await handle.sync()
        } finally {
          await handle.close()
        }
      })
      const written = await runBoundedFsOp(() => fs.lstat(tempPath))
      if (written.size !== sourceSizeBytes) {
        // The source changed while it was copied: publish nothing under this key.
        throw new Error('Canvas mirror asset source changed while it was copied')
      }
      if (repairEmptyFile) {
        await runBoundedFsOp(() => fs.rename(tempPath, destination))
        return { status: 'written', sizeBytes: written.size }
      }
      try {
        await runBoundedFsOp(() => fs.link(tempPath, destination))
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'EEXIST') {
          const winner = await runBoundedFsOp(() => fs.lstat(destination))
          return { status: 'exists', sizeBytes: winner.size }
        }
        // File systems without hard links: move into place unless it appeared meanwhile.
        const appeared = await lstatOrNull(destination)
        if (appeared) return { status: 'exists', sizeBytes: appeared.size }
        await runBoundedFsOp(() => fs.rename(tempPath, destination))
      }
      return { status: 'written', sizeBytes: written.size }
    } finally {
      await fs.rm(tempPath, { force: true }).catch(() => undefined)
      space.release()
    }
  }
  const result = previous ? previous.then(run, run) : run()
  canvasMirrorAssetWrites.set(destination, result)
  try {
    return await result
  } finally {
    if (canvasMirrorAssetWrites.get(destination) === result) {
      canvasMirrorAssetWrites.delete(destination)
    }
  }
}

const getNewestTimeMs = (stats: Stats): number =>
  Math.max(stats.mtimeMs || 0, stats.ctimeMs || 0, stats.birthtimeMs || 0)

const decodeCanvasMirrorRefPart = (value: string): string => {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/** Separators unified, leading and trailing ones dropped; lower case where the file system ignores case. */
const toComparableCanvasMirrorPath = (value: string): string => {
  const unified = value.replace(/[\\/]+/g, '/').replace(/^\/+|\/+$/g, '')
  return process.platform === 'win32' || process.platform === 'darwin'
    ? unified.toLowerCase()
    : unified
}

/**
 * The "assets/<entry>/..." form of an absolute path or a local-media / file
 * URL that points inside `assetDir`; null for anything else. Leading
 * separators are ignored on both sides, as URLs written by earlier versions
 * lost them.
 */
const resolveAbsoluteCanvasMirrorRef = (value: string, assetDir: string): string | null => {
  let candidate = value.trim()
  const scheme = ['local-media://', 'file://'].find((prefix) =>
    candidate.toLowerCase().startsWith(prefix)
  )
  if (scheme) {
    candidate = decodeCanvasMirrorRefPart(candidate.slice(scheme.length).split(/[?#]/)[0])
  } else if (!path.isAbsolute(candidate) && !/^[a-zA-Z]:[\\/]/.test(candidate)) {
    return null
  }
  // Compared segment by segment: a lower-case form can have another length than the
  // original, so a prefix length of one must never be used to cut the other.
  const dirSegments = toComparableCanvasMirrorPath(assetDir).split('/')
  const fileSegments = candidate.replace(/[\\/]+/g, '/').replace(/^\/+|\/+$/g, '').split('/')
  if (
    !dirSegments[0] ||
    fileSegments.length <= dirSegments.length ||
    dirSegments.some((segment, index) => toComparableCanvasMirrorPath(fileSegments[index]) !== segment)
  ) {
    return null
  }
  const segments = fileSegments.slice(dirSegments.length)
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return null
  return `${CANVAS_MIRROR_ASSET_DIRNAME}/${segments.join('/')}`
}

/**
 * Collects every reference into the asset folder found in a stored project
 * file: relative "assets/..." strings, and absolute paths or local-media /
 * file URLs that resolve inside `assetDir`.
 */
const collectCanvasMirrorAssetRefs = (
  value: unknown,
  target: Set<string>,
  assetDir: string,
  depth = 0
): void => {
  if (typeof value === 'string') {
    const normalized = value.replace(/[\\/]+/g, '/').replace(/^\.\//, '')
    if (normalized.startsWith(`${CANVAS_MIRROR_ASSET_DIRNAME}/`)) {
      target.add(normalized)
      return
    }
    const absoluteRef = resolveAbsoluteCanvasMirrorRef(value, assetDir)
    if (absoluteRef) target.add(absoluteRef)
    return
  }
  if (!value || typeof value !== 'object' || depth > 64) return
  if (Array.isArray(value)) {
    for (const entry of value) collectCanvasMirrorAssetRefs(entry, target, assetDir, depth + 1)
    return
  }
  for (const entry of Object.values(value)) {
    collectCanvasMirrorAssetRefs(entry, target, assetDir, depth + 1)
  }
}

/** Bytes kept free on the volume of the mirror besides the asset being copied. */
const CANVAS_MIRROR_FREE_SPACE_MARGIN_BYTES = 256 * 1024 * 1024

/** Bytes of mirror assets being written right now, by volume. */
const canvasMirrorReservedBytesByVolume = new Map<string, number>()

const getCanvasMirrorVolumeId = async (assetDir: string): Promise<string> => {
  try {
    const stats = await runBoundedFsOp(() => fs.stat(assetDir))
    return `dev:${String(stats.dev)}`
  } catch {
    return `root:${path.parse(path.resolve(assetDir)).root.toLowerCase()}`
  }
}

type CanvasMirrorSpaceReservation = {
  /** Bytes of the asset that reached the temporary file (the volume's free space shows them now). */
  wrote(bytes: number): void
  release(): void
}

// Reservations of one volume are judged one at a time (see reserveCanvasMirrorSpace).
const canvasMirrorSpaceChecksByVolume = new Map<string, Promise<unknown>>()

/**
 * Reserves room for one asset on the mirror's volume. The reservations of one
 * volume are judged one at a time (bytes in flight, then free space, then the
 * check and the reservation), so concurrent copies each see the bytes the
 * others are still about to write.
 * Resolves the reservation, or null when the volume cannot hold the asset
 * besides the bytes in flight and the margin. Without volume statistics the
 * write itself reports a full disk, and the copy is allowed.
 */
const reserveCanvasMirrorSpace = async (
  assetDir: string,
  sizeBytes: number
): Promise<CanvasMirrorSpaceReservation | null> => {
  const volumeId = await getCanvasMirrorVolumeId(assetDir)
  const check = async (): Promise<CanvasMirrorSpaceReservation | null> => {
    // The bytes in flight are read before the free space: a copy that reaches the disk
    // while statfs runs gives back its reservation, and a free-space figure taken before
    // its bytes landed must not be checked against the smaller remainder. The reserved
    // figure can only shrink while this step runs (no other reservation of this volume
    // is judged meanwhile), so the check errs on the side of refusing.
    const reserved = canvasMirrorReservedBytesByVolume.get(volumeId) ?? 0
    let available = Number.POSITIVE_INFINITY
    if (typeof fs.statfs === 'function') {
      try {
        const stats = await runBoundedFsOp(() => fs.statfs(assetDir))
        available = Number(stats.bavail) * Number(stats.bsize)
      } catch {
        available = Number.POSITIVE_INFINITY
      }
    }
    if (
      Number.isFinite(available) &&
      available < reserved + sizeBytes + CANVAS_MIRROR_FREE_SPACE_MARGIN_BYTES
    ) {
      return null
    }
    canvasMirrorReservedBytesByVolume.set(
      volumeId,
      (canvasMirrorReservedBytesByVolume.get(volumeId) ?? 0) + sizeBytes
    )
    let outstanding = sizeBytes
    const give = (bytes: number): void => {
      const amount = Math.min(outstanding, Math.max(0, bytes))
      if (amount <= 0) return
      outstanding -= amount
      const remaining = (canvasMirrorReservedBytesByVolume.get(volumeId) ?? 0) - amount
      if (remaining > 0) canvasMirrorReservedBytesByVolume.set(volumeId, remaining)
      else canvasMirrorReservedBytesByVolume.delete(volumeId)
    }
    return { wrote: give, release: () => give(outstanding) }
  }
  const previous = canvasMirrorSpaceChecksByVolume.get(volumeId) ?? Promise.resolve()
  const step = previous.then(check, check)
  const settled = step.catch(() => undefined)
  canvasMirrorSpaceChecksByVolume.set(volumeId, settled)
  void settled.then(() => {
    if (canvasMirrorSpaceChecksByVolume.get(volumeId) === settled) {
      canvasMirrorSpaceChecksByVolume.delete(volumeId)
    }
  })
  return step
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

  pruneAutoSaveProjects = async (
    req: PruneAutoSaveProjectsReq
  ): Promise<PruneAutoSaveProjectsResp> => {
    const autoSaveRoot = path.resolve(getCurrentUserDataDirectoryState().autoSaveRoot)
    const currentProjectDir = path.join(autoSaveRoot, req.currentProjectDirName)
    const entries = await runBoundedFsOp(() =>
      fs.readdir(autoSaveRoot, { withFileTypes: true })
    ).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return []
      throw error
    })
    const projects: { projectDir: string; lastModifiedMs: number }[] = []
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue
      const projectDir = path.join(autoSaveRoot, entry.name)
      const relative = path.relative(autoSaveRoot, projectDir)
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) continue
      try {
        const realProjectDir = await runBoundedFsOp(() => fs.realpath(projectDir))
        const realRoot = await runBoundedFsOp(() => fs.realpath(autoSaveRoot))
        const realRelative = path.relative(realRoot, realProjectDir)
        if (!realRelative || realRelative.startsWith('..') || path.isAbsolute(realRelative))
          continue
        const canvasPath = path.join(realProjectDir, 'project.mpcanvas')
        const stats = await runBoundedFsOp(() => fs.stat(canvasPath))
        if (stats.isFile())
          projects.push({ projectDir: realProjectDir, lastModifiedMs: stats.mtimeMs })
      } catch {
        // Ignore incomplete cache directories.
      }
    }
    projects.sort((left, right) => right.lastModifiedMs - left.lastModifiedMs)
    const removedProjectDirs: string[] = []
    for (const project of projects.slice(req.maxProjects)) {
      if (path.resolve(project.projectDir) === path.resolve(currentProjectDir)) continue
      await runBoundedFsOp(() => fs.rm(project.projectDir, { recursive: true, force: true }))
      removedProjectDirs.push(project.projectDir)
    }
    return { removedProjectDirs }
  }

  saveImageToPath = async (req: SaveImageToPathReq): Promise<SaveImageToPathResp> => {
    const { image, outputPath, filename } = req
    requireBoundedPayload(image, MAX_FULL_FILE_BYTES, 'Image')
    const fullPath = resolveContainedFile(outputPath, filename)

    if (!(await pathExists(outputPath))) {
      await runBoundedFsOp(() => fs.mkdir(outputPath, { recursive: true }))
    }

    await runBoundedFsOp(() => fs.writeFile(fullPath, Buffer.from(image)))

    return { success: true, fullPath }
  }

  saveQAppInputImage = async (req: SaveQAppInputImageReq): Promise<SaveQAppInputImageResp> => {
    const outputPath = path.join(app.getPath('userData'), QAPP_INPUT_IMAGE_DIR)
    await runBoundedFsOp(() => fs.mkdir(outputPath, { recursive: true }))

    requireBoundedPayload(req.image, MAX_FULL_FILE_BYTES, 'Image')
    const safeName = requireBasename(req.filename)
    const extension = path.extname(safeName)
    const baseName = extension ? safeName.slice(0, -extension.length) : safeName
    const filename = `${baseName}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${extension || '.png'}`
    const fullPath = resolveContainedFile(outputPath, filename)
    await runBoundedFsOp(() => fs.writeFile(fullPath, Buffer.from(req.image)))

    return { success: true, fullPath, filename }
  }

  readImageFromPath = async (req: ReadImageFromPathReq): Promise<ReadImageFromPathResp> => {
    const storageState = getCurrentUserDataDirectoryState()
    // The temp media folder only once verified as main's own private directory. A file the
    // user dropped from a mapped network drive is read once under its one-use read grant.
    const fullPath =
      resolveAuthorizedLocalMediaPath(req.fullPath, [
        app.getPath('userData'),
        ...getVerifiedLocalMediaTempRoots(),
        storageState.projectRoot,
        storageState.autoSaveRoot
      ]) ?? consumeLocalMediaReadGrant(req.fullPath)

    if (!fullPath) {
      throw new Error('Local image path is not authorized')
    }

    if (
      req.maxBytes !== undefined &&
      (!Number.isSafeInteger(req.maxBytes) ||
        req.maxBytes < 1 ||
        req.maxBytes > MAX_FULL_FILE_BYTES)
    ) {
      throw new Error(`Invalid image maxBytes: expected 1-${MAX_FULL_FILE_BYTES}`)
    }
    const maxBytes = Math.min(MAX_FULL_FILE_BYTES, req.maxBytes ?? MAX_FULL_FILE_BYTES)

    if (!(await pathExists(fullPath))) {
      throw new Error(`File not found: ${fullPath}`)
    }

    let buffer: Buffer
    if (req.maxBytes !== undefined) {
      buffer = await readImageFileWithinByteBudget(fullPath, maxBytes)
    } else {
      await assertReadableFileWithinLimit(fullPath, maxBytes)
      buffer = await runBoundedFsOp(() => fs.readFile(fullPath))
    }
    // A file may grow after stat; never return an oversized IPC payload.
    requireBoundedPayload(buffer, maxBytes, 'Image')
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

    await assertReadableFileWithinLimit(fullPath, MAX_TEXT_FILE_BYTES)
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

    await assertReadableFileWithinLimit(fullPath, MAX_FULL_FILE_BYTES)
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
    const contentBytes = Buffer.byteLength(content, 'utf8')
    if (contentBytes > MAX_TEXT_FILE_BYTES) {
      throw new Error(`Text exceeds the ${MAX_TEXT_FILE_BYTES}-byte IPC limit`)
    }
    const fullPath = resolveContainedFile(outputPath, filename)

    if (!(await pathExists(outputPath))) {
      await runBoundedFsOp(() => fs.mkdir(outputPath, { recursive: true }))
    }

    await runBoundedFsOp(async () => {
      const tempPath = `${fullPath}.tmp-${process.pid}-${Date.now()}`
      try {
        // Flushed before the rename: callers delete what the previous version
        // of the file referenced once this write is acknowledged.
        const handle = await fs.open(tempPath, 'w')
        try {
          await handle.writeFile(content, 'utf8')
          await handle.sync()
        } finally {
          await handle.close()
        }
        await fs.rename(tempPath, fullPath)
      } finally {
        await fs.rm(tempPath, { force: true }).catch(() => undefined)
      }
    })

    return {
      success: true,
      fullPath
    }
  }

  /** The roots the renderer may read media from; the same list readImageFromPath uses. */
  private getCanvasMirrorSourceRoots = (): LocalMediaRoot[] => {
    const storageState = getCurrentUserDataDirectoryState()
    return [
      app.getPath('userData'),
      ...getVerifiedLocalMediaTempRoots(),
      storageState.projectRoot,
      storageState.autoSaveRoot
    ]
  }

  copyCanvasMirrorAsset = async (req: CopyCanvasMirrorAssetReq): Promise<CanvasMirrorAssetResp> => {
    const assetFileName = requireCanvasMirrorAssetFileName(req.assetFileName)
    // Canonical (symlinks resolved) and authorized exactly like readImageFromPath.
    const sourcePath = resolveAuthorizedLocalMediaPath(
      req.sourcePath,
      this.getCanvasMirrorSourceRoots()
    )
    if (!sourcePath) {
      throw new Error('Canvas mirror asset source is not authorized')
    }
    const sourceStats = await runBoundedFsOp(() => fs.stat(sourcePath))
    if (!sourceStats.isFile()) {
      throw new Error('Canvas mirror asset source is not a file')
    }
    // File to file: no IPC payload, so no payload limit; only the free disk space bounds it.
    const location = await resolveCanvasMirrorAssetDir(req.projectDirName, true)
    if (!location) throw new Error('Canvas mirror folder is unavailable')
    // The free space is checked (and reserved) by the publish, as for a write.
    return publishCanvasMirrorAsset(
      location.assetDir,
      assetFileName,
      sourceStats.size,
      async (handle, wrote) => {
        // Streamed into our own temporary file, so a read-only source copies like any other.
        for await (const chunk of createReadStream(sourcePath)) {
          const buffer = chunk as Buffer
          for (let offset = 0; offset < buffer.length; ) {
            const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset)
            offset += bytesWritten
            wrote(bytesWritten)
          }
        }
      }
    )
  }

  writeCanvasMirrorAsset = async (
    req: WriteCanvasMirrorAssetReq
  ): Promise<CanvasMirrorAssetResp> => {
    const assetFileName = requireCanvasMirrorAssetFileName(req.assetFileName)
    requireBoundedPayload(req.data, MAX_FULL_FILE_BYTES, 'Canvas mirror asset')
    const location = await resolveCanvasMirrorAssetDir(req.projectDirName, true)
    if (!location) throw new Error('Canvas mirror folder is unavailable')
    return publishCanvasMirrorAsset(
      location.assetDir,
      assetFileName,
      req.data.byteLength,
      (handle) => handle.writeFile(Buffer.from(req.data))
    )
  }

  listCanvasMirrorAssets = async (
    req: ListCanvasMirrorAssetsReq
  ): Promise<ListCanvasMirrorAssetsResp> => {
    const location = await resolveCanvasMirrorAssetDir(req.projectDirName, false)
    if (!location) return { assetFileNames: [] }
    const entries = await runBoundedFsOp(() =>
      fs.readdir(location.assetDir, { withFileTypes: true })
    )
    const assetFileNames: string[] = []
    for (const entry of entries) {
      if (!entry.isFile() || !CANVAS_MIRROR_ASSET_FILE_NAME_PATTERN.test(entry.name)) continue
      // An empty file is an interrupted write; report it as missing so it is written again.
      const stats = await lstatOrNull(path.join(location.assetDir, entry.name))
      if (stats?.isFile() && stats.size > 0) assetFileNames.push(entry.name)
    }
    return { assetFileNames }
  }

  /**
   * Deletes the content-keyed assets and the snapshot folders of earlier
   * versions that the stored project file no longer references. Only entries
   * directly under <autoSaveRoot>/<projectDirName>/assets that match one of
   * those two name patterns are ever removed; entries younger than the grace
   * period, entries the caller asks to keep and symbolic links are left alone.
   * Without a readable project file nothing is deleted.
   */
  pruneCanvasMirrorAssets = async (
    req: PruneCanvasMirrorAssetsReq
  ): Promise<PruneCanvasMirrorAssetsResp> => {
    const result: PruneCanvasMirrorAssetsResp = {
      removedAssetFileNames: [],
      removedSnapshotDirNames: []
    }
    const location = await resolveCanvasMirrorAssetDir(req.projectDirName, false)
    if (!location) return result

    const canvasPath = path.join(location.projectDir, CANVAS_MIRROR_CANVAS_FILENAME)
    const referenced = new Set<string>()
    try {
      const canvasStats = await runBoundedFsOp(() => fs.lstat(canvasPath))
      if (canvasStats.isSymbolicLink() || !canvasStats.isFile()) return result
      if (canvasStats.size > MAX_TEXT_FILE_BYTES) return result
      const parsed: unknown = JSON.parse(await runBoundedFsOp(() => fs.readFile(canvasPath, 'utf8')))
      if (!parsed || typeof parsed !== 'object') return result
      collectCanvasMirrorAssetRefs(parsed, referenced, location.assetDir)
    } catch {
      return result
    }

    const keepEntryNames = new Set<string>(req.keepEntryNames)
    const keepAssetKeys = new Set<string>(
      req.keepAssetKeys.filter((key) => CANVAS_MIRROR_ASSET_KEY_PATTERN.test(key))
    )
    for (const ref of referenced) {
      const entryName = ref.split('/')[1]
      if (entryName) keepEntryNames.add(entryName)
    }
    const comparable = (name: string): string =>
      process.platform === 'win32' || process.platform === 'darwin' ? name.toLowerCase() : name
    const keepComparableNames = new Set([...keepEntryNames].map(comparable))

    const now = Date.now()
    const isYoung = (stats: Stats): boolean =>
      now - getNewestTimeMs(stats) < CANVAS_MIRROR_PRUNE_GRACE_MS
    const entries = await runBoundedFsOp(() =>
      fs.readdir(location.assetDir, { withFileTypes: true })
    )
    for (const entry of entries) {
      const entryPath = path.join(location.assetDir, entry.name)
      if (path.dirname(entryPath) !== location.assetDir) continue
      if (keepComparableNames.has(comparable(entry.name))) continue
      try {
        const stats = await runBoundedFsOp(() => fs.lstat(entryPath))
        if (stats.isSymbolicLink()) continue

        if (stats.isFile()) {
          const isAsset = CANVAS_MIRROR_ASSET_FILE_NAME_PATTERN.test(entry.name)
          const isTemp = CANVAS_MIRROR_TEMP_FILE_PATTERN.test(entry.name)
          if (!isAsset && !isTemp) continue
          if (isAsset && keepAssetKeys.has(entry.name.split('.')[0])) continue
          if (isYoung(stats)) continue
          await runBoundedFsOp(() => fs.unlink(entryPath))
          if (isAsset) result.removedAssetFileNames.push(entry.name)
          continue
        }

        if (!stats.isDirectory() || !CANVAS_MIRROR_SNAPSHOT_DIR_PATTERN.test(entry.name)) continue
        // A writer of an earlier version fills the category folders of a snapshot before
        // its project file; their timestamps move with every file it adds.
        let newestMs = getNewestTimeMs(stats)
        const children = await runBoundedFsOp(() => fs.readdir(entryPath, { withFileTypes: true }))
        for (const child of children) {
          const childStats = await lstatOrNull(path.join(entryPath, child.name))
          if (childStats) newestMs = Math.max(newestMs, getNewestTimeMs(childStats))
        }
        if (now - newestMs < CANVAS_MIRROR_PRUNE_GRACE_MS) continue
        await runBoundedFsOp(() => fs.rm(entryPath, { recursive: true, force: true }))
        result.removedSnapshotDirNames.push(entry.name)
      } catch (error) {
        console.warn('[svcFs] Failed to prune a canvas mirror entry:', entry.name, error)
      }
    }
    return result
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
