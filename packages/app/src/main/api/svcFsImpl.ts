import {
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
  WriteTextFileResp,
  BATCH_MANIFEST_VERSION,
  BatchImageFile,
  BatchManifest,
  BatchSourceFingerprint,
  BatchWorkspacePaths,
  ScanBatchImagesReq,
  ScanBatchImagesResp,
  PrepareBatchWorkspaceReq,
  PrepareBatchWorkspaceResp,
  ReadBatchManifestReq,
  ReadBatchManifestResp,
  WriteBatchManifestReq,
  WriteBatchManifestResp,
  ReadBatchSourceImageReq,
  ReadBatchSourceImageResp,
  CommitBatchPngReq,
  CommitBatchPngResp,
  RemoveBatchStagingArtifactsReq,
  RemoveBatchStagingArtifactsResp,
  FailBatchItemReq,
  FailBatchItemResp
} from '@shared/api/svcFs'
import fs from 'fs/promises'
import { constants as fsConstants } from 'fs'
import * as path from 'path'
import { getCurrentUserDataDirectoryState } from '../config/userDataDirectory'
import { app, nativeImage } from 'electron'
import { resolveAuthorizedLocalMediaPath } from '../localMediaAccess'
import { execFile } from 'child_process'
import { promisify } from 'util'

const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.tif', '.tiff']
const MAX_CONCURRENT_FS_OPS = 16
const QAPP_INPUT_IMAGE_DIR = 'qapp-input-images'
const BATCH_METADATA_DIR = '.magicpot-batch'
const BATCH_MANIFEST_FILE = 'manifest.json'
const BATCH_STAGING_DIR = 'staging'
const BATCH_ERRORS_DIR = 'errors'
const BATCH_MIGRATION_SUFFIX = '.migration'
const ATOMIC_REPLACE_RETRY_MS = [25, 75, 150, 300, 600] as const
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const LORA_TRIGGER_SIDECAR_EXE =
  process.platform === 'win32' ? 'lora-trigger-sidecar.exe' : 'lora-trigger-sidecar'
const LORA_TRIGGER_SIDECAR_TIMEOUT_MS = 1500
const execFileAsync = promisify(execFile)
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const isTransientWindowsFsError = (error: unknown): boolean =>
  error instanceof Error &&
  'code' in error &&
  ['EACCES', 'EBUSY', 'EPERM'].includes(String(error.code))

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

function normalizeExtension(value: string): string {
  const normalized = value.trim().toLowerCase()
  return normalized.startsWith('.') ? normalized : `.${normalized}`
}

const toPortableRelativePath = (value: string): string => value.split(path.sep).join('/')

const requireSafeRelativePath = (value: string): string => {
  if (!value || path.isAbsolute(value) || /^[a-zA-Z]:/.test(value)) {
    throw new Error('Invalid relative path: expected a non-empty relative path')
  }
  const normalized = value.replace(/\\/g, '/')
  const segments = normalized.split('/')
  if (
    segments.some(
      (segment) => !segment || segment === '.' || segment === '..' || segment.includes('\0')
    )
  ) {
    throw new Error('Invalid relative path: path traversal is not allowed')
  }
  return normalized
}

const resolveContainedRelativePath = (root: string, relativePath: string): string => {
  const resolvedRoot = path.resolve(root)
  const fullPath = path.resolve(resolvedRoot, ...requireSafeRelativePath(relativePath).split('/'))
  const relative = path.relative(resolvedRoot, fullPath)
  if (
    !relative ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error('Invalid relative path: resolved path is outside the batch directory')
  }
  return fullPath
}

const isPathOutside = (root: string, target: string): boolean => {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
}

const lstatIfExists = async (
  targetPath: string
): Promise<Awaited<ReturnType<typeof fs.lstat>> | null> => {
  try {
    return await runBoundedFsOp(() => fs.lstat(targetPath))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

const assertNoSymbolicLinkComponents = async (
  anchor: string,
  target: string,
  label: string
): Promise<void> => {
  const resolvedAnchor = path.resolve(anchor)
  const resolvedTarget = path.resolve(target)
  if (isPathOutside(resolvedAnchor, resolvedTarget)) {
    throw new Error(`${label} escapes the batch workspace`)
  }

  const relative = path.relative(resolvedAnchor, resolvedTarget)
  const components = [resolvedAnchor]
  let current = resolvedAnchor
  if (relative) {
    for (const segment of relative.split(path.sep)) {
      current = path.join(current, segment)
      components.push(current)
    }
  }

  for (let index = 0; index < components.length; index += 1) {
    const component = components[index]
    const stats = await lstatIfExists(component)
    if (!stats) continue
    if (stats.isSymbolicLink()) {
      throw new Error(`Symbolic links or junctions are not allowed for ${label}: ${component}`)
    }
    if (index < components.length - 1 && !stats.isDirectory()) {
      throw new Error(`${label} has a non-directory path component: ${component}`)
    }
  }
}

const normalizeRealPathForRuntime = (requestedPath: string, realPath: string): string => {
  if (process.platform !== 'win32') return path.normalize(realPath)
  if (/^[a-zA-Z]:[\\/]/.test(realPath) || realPath.startsWith('\\\\')) {
    return path.win32.normalize(realPath)
  }

  // Git Bash/MSYS can surface a POSIX realpath (/Users/...) even though Node's path module and
  // renderer IPC use a Windows drive path. Preserve the requested drive while retaining the
  // canonical suffix so persisted manifests remain usable by native Windows APIs.
  const drive = path.win32.parse(path.resolve(requestedPath)).root.slice(0, 2)
  if (!drive || !realPath.startsWith('/')) return path.normalize(realPath)
  return path.win32.normalize(`${drive}${realPath.replace(/\//g, '\\')}`)
}

const canonicalizeBatchSourceRoot = async (sourceRoot: string): Promise<string> => {
  const requestedRoot = path.resolve(sourceRoot)
  const requestedStats = await runBoundedFsOp(() => fs.lstat(requestedRoot))
  if (requestedStats.isSymbolicLink()) {
    throw new Error(`Batch source root cannot be a symbolic link or junction: ${requestedRoot}`)
  }
  if (!requestedStats.isDirectory()) {
    throw new Error(`Batch source is not a directory: ${requestedRoot}`)
  }

  const realRoot = await runBoundedFsOp(() => fs.realpath(requestedRoot))
  const canonicalRoot = normalizeRealPathForRuntime(requestedRoot, realRoot)
  const canonicalStats = await runBoundedFsOp(() => fs.lstat(canonicalRoot))
  if (canonicalStats.isSymbolicLink() || !canonicalStats.isDirectory()) {
    throw new Error(`Batch source is not a canonical directory: ${requestedRoot}`)
  }
  return canonicalRoot
}

const resolveSafeBatchPath = async (root: string, relativePath: string): Promise<string> => {
  const target = resolveContainedRelativePath(root, relativePath)
  await assertNoSymbolicLinkComponents(root, target, 'batch path')
  return target
}

const resolveCanonicalBatchSourcePath = async (
  canonicalSourceRoot: string,
  relativePath: string
): Promise<string> => {
  const sourcePath = resolveContainedRelativePath(canonicalSourceRoot, relativePath)
  await assertNoSymbolicLinkComponents(canonicalSourceRoot, sourcePath, 'batch source')
  const realSourcePath = normalizeRealPathForRuntime(
    sourcePath,
    await runBoundedFsOp(() => fs.realpath(sourcePath))
  )
  if (
    isPathOutside(canonicalSourceRoot, realSourcePath) ||
    realSourcePath === canonicalSourceRoot
  ) {
    throw new Error('Batch source image resolves outside the canonical source root')
  }
  return realSourcePath
}

const fingerprintMatches = (
  stats: Awaited<ReturnType<typeof fs.stat>>,
  fingerprint: BatchSourceFingerprint
): boolean =>
  stats.isFile() && stats.size === fingerprint.size && stats.mtimeMs === fingerprint.mtimeMs

const readVerifiedBatchSource = async (
  canonicalSourceRoot: string,
  relativePath: string,
  fingerprint: BatchSourceFingerprint,
  readBytes: boolean
): Promise<Buffer | null> => {
  const sourcePath = resolveContainedRelativePath(canonicalSourceRoot, relativePath)
  await assertNoSymbolicLinkComponents(canonicalSourceRoot, sourcePath, 'batch source image')

  return runBoundedFsOp(async () => {
    const sourceLstat = await fs.lstat(sourcePath)
    if (sourceLstat.isSymbolicLink() || !sourceLstat.isFile()) {
      throw new Error('Batch source image must be a regular file, not a symbolic link or junction')
    }

    // Keep this realpath check adjacent to the handle open so the bytes are read from the
    // canonical, contained source selected by the scan rather than a renderer-supplied path.
    const realSourcePath = normalizeRealPathForRuntime(sourcePath, await fs.realpath(sourcePath))
    if (
      isPathOutside(canonicalSourceRoot, realSourcePath) ||
      realSourcePath === canonicalSourceRoot
    ) {
      throw new Error('Batch source image resolves outside the canonical source root')
    }
    const handle = await fs.open(realSourcePath, 'r')
    try {
      const before = await handle.stat()
      if (!fingerprintMatches(before, fingerprint)) {
        throw new Error('Batch source image changed after scanning')
      }
      if (before.size > MAX_FULL_FILE_BYTES) {
        throw new Error(`Batch source image exceeds the ${MAX_FULL_FILE_BYTES}-byte IPC limit`)
      }
      const bytes = readBytes ? await handle.readFile() : null
      const after = await handle.stat()
      if (!fingerprintMatches(after, fingerprint)) {
        throw new Error('Batch source image changed while it was being read')
      }
      return bytes
    } finally {
      await handle.close()
    }
  })
}

const hasPngSignature = async (filePath: string): Promise<boolean> => {
  try {
    const handle = await fs.open(filePath, 'r')
    try {
      const signature = Buffer.alloc(PNG_SIGNATURE.length)
      const { bytesRead } = await handle.read(signature, 0, signature.length, 0)
      return bytesRead === PNG_SIGNATURE.length && signature.equals(PNG_SIGNATURE)
    } finally {
      await handle.close()
    }
  } catch {
    return false
  }
}

const isBatchOutputValid = async (filePath: string): Promise<boolean> => {
  try {
    const stat = await runBoundedFsOp(() => fs.stat(filePath))
    return stat.isFile() && stat.size > PNG_SIGNATURE.length && (await hasPngSignature(filePath))
  } catch {
    return false
  }
}

const createBatchWorkspacePaths = (canonicalSourceRoot: string): BatchWorkspacePaths => {
  const outputRoot = `${canonicalSourceRoot}.output`
  const metadataRoot = path.join(outputRoot, BATCH_METADATA_DIR)
  return {
    sourceRoot: canonicalSourceRoot,
    // Compatibility alias for persisted batch states created before metadata moved into outputRoot.
    workRoot: outputRoot,
    outputRoot,
    metadataRoot,
    stagingRoot: path.join(metadataRoot, BATCH_STAGING_DIR),
    manifestPath: path.join(metadataRoot, BATCH_MANIFEST_FILE)
  }
}

const getLegacyBatchPaths = (
  paths: BatchWorkspacePaths
): { legacyWorkRoot: string; legacyMetadataRoot: string; migrationRoot: string } => {
  const legacyWorkRoot = `${paths.sourceRoot}.work`
  return {
    legacyWorkRoot,
    legacyMetadataRoot: path.join(legacyWorkRoot, BATCH_METADATA_DIR),
    migrationRoot: `${paths.metadataRoot}${BATCH_MIGRATION_SUFFIX}`
  }
}

const assertBatchWorkspacePathsSafe = async (paths: BatchWorkspacePaths): Promise<void> => {
  const workspaceAnchor = path.dirname(paths.sourceRoot)
  const { legacyWorkRoot, legacyMetadataRoot, migrationRoot } = getLegacyBatchPaths(paths)
  const guardedPaths: Array<[string, string]> = [
    [paths.outputRoot, 'batch outputRoot'],
    [paths.metadataRoot, 'batch metadataRoot'],
    [paths.manifestPath, 'batch manifest'],
    [paths.stagingRoot, 'batch staging'],
    [path.join(paths.metadataRoot, BATCH_ERRORS_DIR), 'batch errors'],
    [legacyWorkRoot, 'legacy batch .work'],
    [legacyMetadataRoot, 'legacy batch metadata'],
    [migrationRoot, 'batch metadata migration staging']
  ]
  for (const [target, label] of guardedPaths) {
    await assertNoSymbolicLinkComponents(workspaceAnchor, target, label)
  }
}

const getBatchWorkspacePaths = async (sourceRoot: string): Promise<BatchWorkspacePaths> => {
  const canonicalSourceRoot = await canonicalizeBatchSourceRoot(sourceRoot)
  const paths = createBatchWorkspacePaths(canonicalSourceRoot)
  await assertBatchWorkspacePathsSafe(paths)
  return paths
}

const renameWithWindowsRetry = async (sourcePath: string, targetPath: string): Promise<void> => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.rename(sourcePath, targetPath)
      return
    } catch (error) {
      const retryMs = ATOMIC_REPLACE_RETRY_MS[attempt]
      if (retryMs === undefined || !isTransientWindowsFsError(error)) throw error
      await delay(retryMs)
    }
  }
}

const ensureSecureDirectory = async (
  anchor: string,
  directory: string,
  label: string
): Promise<void> => {
  await assertNoSymbolicLinkComponents(anchor, directory, label)
  await runBoundedFsOp(() => fs.mkdir(directory, { recursive: true }))
  await assertNoSymbolicLinkComponents(anchor, directory, label)
  const stats = await runBoundedFsOp(() => fs.lstat(directory))
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`${label} is not a real directory: ${directory}`)
  }
}

const filesHaveEqualContents = async (leftPath: string, rightPath: string): Promise<boolean> =>
  runBoundedFsOp(async () => {
    const [left, right] = await Promise.all([fs.open(leftPath, 'r'), fs.open(rightPath, 'r')])
    try {
      const [leftStats, rightStats] = await Promise.all([left.stat(), right.stat()])
      if (!leftStats.isFile() || !rightStats.isFile() || leftStats.size !== rightStats.size) {
        return false
      }
      const chunkSize = 64 * 1024
      const leftBuffer = Buffer.alloc(chunkSize)
      const rightBuffer = Buffer.alloc(chunkSize)
      for (let position = 0; position < leftStats.size; position += chunkSize) {
        const length = Math.min(chunkSize, leftStats.size - position)
        const [leftRead, rightRead] = await Promise.all([
          left.read(leftBuffer, 0, length, position),
          right.read(rightBuffer, 0, length, position)
        ])
        if (
          leftRead.bytesRead !== length ||
          rightRead.bytesRead !== length ||
          !leftBuffer.subarray(0, length).equals(rightBuffer.subarray(0, length))
        ) {
          return false
        }
      }
      return true
    } finally {
      await Promise.all([left.close(), right.close()])
    }
  })

const copyFileCrashSafely = async (
  anchor: string,
  sourcePath: string,
  targetPath: string,
  label: string
): Promise<void> => {
  await ensureSecureDirectory(anchor, path.dirname(targetPath), label)
  await assertNoSymbolicLinkComponents(anchor, targetPath, label)
  const existing = await lstatIfExists(targetPath)
  if (existing) {
    if (
      existing.isSymbolicLink() ||
      !existing.isFile() ||
      !(await filesHaveEqualContents(sourcePath, targetPath))
    ) {
      throw new Error(`Legacy batch metadata conflicts with existing destination: ${targetPath}`)
    }
    return
  }

  const tempPath = path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.migration-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  )
  await assertNoSymbolicLinkComponents(anchor, tempPath, label)
  try {
    await runBoundedFsOp(async () => {
      const source = await fs.open(sourcePath, 'r')
      let target: Awaited<ReturnType<typeof fs.open>> | undefined
      try {
        target = await fs.open(tempPath, 'wx')
        const buffer = Buffer.alloc(64 * 1024)
        let position = 0
        for (;;) {
          const { bytesRead } = await source.read(buffer, 0, buffer.length, position)
          if (bytesRead === 0) break
          let written = 0
          while (written < bytesRead) {
            const result = await target.write(
              buffer,
              written,
              bytesRead - written,
              position + written
            )
            written += result.bytesWritten
          }
          position += bytesRead
        }
        await target.sync()
      } finally {
        await Promise.all([source.close(), target?.close()])
      }
    })
    await assertNoSymbolicLinkComponents(anchor, targetPath, label)
    await assertNoSymbolicLinkComponents(anchor, tempPath, label)
    await runBoundedFsOp(() => renameWithWindowsRetry(tempPath, targetPath))
  } finally {
    await runBoundedFsOp(() => fs.rm(tempPath, { force: true })).catch(() => undefined)
  }
}

const copyLegacyMetadataTree = async (
  sourceRoot: string,
  destinationRoot: string,
  destinationAnchor: string
): Promise<void> => {
  const pending: Array<{ source: string; destination: string }> = [
    { source: sourceRoot, destination: destinationRoot }
  ]
  while (pending.length > 0) {
    const current = pending.shift()
    if (!current) continue
    const sourceStats = await runBoundedFsOp(() => fs.lstat(current.source))
    if (sourceStats.isSymbolicLink()) {
      throw new Error(
        `Legacy batch metadata contains a symbolic link or junction: ${current.source}`
      )
    }
    if (sourceStats.isDirectory()) {
      await ensureSecureDirectory(
        destinationAnchor,
        current.destination,
        'batch metadata migration'
      )
      const entries = await runBoundedFsOp(() => fs.readdir(current.source))
      entries.sort((left, right) => left.localeCompare(right))
      for (const entry of entries) {
        pending.push({
          source: path.join(current.source, entry),
          destination: path.join(current.destination, entry)
        })
      }
      continue
    }
    if (!sourceStats.isFile()) {
      throw new Error(`Legacy batch metadata contains an unsupported entry: ${current.source}`)
    }
    await copyFileCrashSafely(
      destinationAnchor,
      current.source,
      current.destination,
      'batch metadata migration'
    )
  }
}

const verifyLegacyMetadataCopied = async (
  sourceRoot: string,
  destinationRoot: string
): Promise<void> => {
  const pending: Array<{ source: string; destination: string }> = [
    { source: sourceRoot, destination: destinationRoot }
  ]
  while (pending.length > 0) {
    const current = pending.shift()
    if (!current) continue
    const [sourceStats, destinationStats] = await Promise.all([
      runBoundedFsOp(() => fs.lstat(current.source)),
      lstatIfExists(current.destination)
    ])
    if (sourceStats.isSymbolicLink() || destinationStats?.isSymbolicLink()) {
      throw new Error('Symbolic links or junctions are not allowed during batch metadata migration')
    }
    if (!destinationStats) {
      throw new Error(`Legacy batch metadata was not fully copied: ${current.destination}`)
    }
    if (sourceStats.isDirectory()) {
      if (!destinationStats.isDirectory()) {
        throw new Error(`Legacy batch metadata destination type mismatch: ${current.destination}`)
      }
      const entries = await runBoundedFsOp(() => fs.readdir(current.source))
      for (const entry of entries) {
        pending.push({
          source: path.join(current.source, entry),
          destination: path.join(current.destination, entry)
        })
      }
    } else if (
      !sourceStats.isFile() ||
      !destinationStats.isFile() ||
      !(await filesHaveEqualContents(current.source, current.destination))
    ) {
      throw new Error(`Legacy batch metadata was not safely copied: ${current.destination}`)
    }
  }
}

const assertTreeHasNoSymbolicLinks = async (root: string): Promise<void> => {
  const pending = [root]
  while (pending.length > 0) {
    const current = pending.shift()
    if (!current) continue
    const stats = await runBoundedFsOp(() => fs.lstat(current))
    if (stats.isSymbolicLink()) {
      throw new Error(
        `Symbolic links or junctions are not allowed in legacy batch .work: ${current}`
      )
    }
    if (!stats.isDirectory()) continue
    const entries = await runBoundedFsOp(() => fs.readdir(current))
    for (const entry of entries) pending.push(path.join(current, entry))
  }
}

const migrateLegacyBatchWorkspace = async (paths: BatchWorkspacePaths): Promise<void> => {
  await assertBatchWorkspacePathsSafe(paths)
  const workspaceAnchor = path.dirname(paths.sourceRoot)
  const { legacyWorkRoot, legacyMetadataRoot, migrationRoot } = getLegacyBatchPaths(paths)
  const legacyStats = await lstatIfExists(legacyWorkRoot)
  if (!legacyStats) return
  if (legacyStats.isSymbolicLink() || !legacyStats.isDirectory()) {
    throw new Error(`Legacy batch .work must be a real directory: ${legacyWorkRoot}`)
  }
  await assertTreeHasNoSymbolicLinks(legacyWorkRoot)

  const legacyMetadataStats = await lstatIfExists(legacyMetadataRoot)
  if (legacyMetadataStats) {
    if (legacyMetadataStats.isSymbolicLink() || !legacyMetadataStats.isDirectory()) {
      throw new Error(`Legacy batch metadata must be a real directory: ${legacyMetadataRoot}`)
    }
    await ensureSecureDirectory(workspaceAnchor, paths.outputRoot, 'batch outputRoot')
    const destinationStats = await lstatIfExists(paths.metadataRoot)
    if (!destinationStats) {
      await copyLegacyMetadataTree(legacyMetadataRoot, migrationRoot, workspaceAnchor)
      await verifyLegacyMetadataCopied(legacyMetadataRoot, migrationRoot)
      await assertNoSymbolicLinkComponents(
        workspaceAnchor,
        paths.metadataRoot,
        'batch metadataRoot'
      )
      await runBoundedFsOp(() => renameWithWindowsRetry(migrationRoot, paths.metadataRoot))
    } else {
      if (destinationStats.isSymbolicLink() || !destinationStats.isDirectory()) {
        throw new Error(
          `Batch metadata destination must be a real directory: ${paths.metadataRoot}`
        )
      }
      await copyLegacyMetadataTree(legacyMetadataRoot, paths.metadataRoot, workspaceAnchor)
    }
    await assertBatchWorkspacePathsSafe(paths)
    await verifyLegacyMetadataCopied(legacyMetadataRoot, paths.metadataRoot)
  }

  const staleMigrationStats = await lstatIfExists(migrationRoot)
  if (staleMigrationStats) {
    await assertTreeHasNoSymbolicLinks(migrationRoot)
    await runBoundedFsOp(() => fs.rm(migrationRoot, { recursive: true, force: true }))
  }

  await assertTreeHasNoSymbolicLinks(legacyWorkRoot)
  if (legacyMetadataStats) {
    await verifyLegacyMetadataCopied(legacyMetadataRoot, paths.metadataRoot)
  }
  await runBoundedFsOp(() => fs.rm(legacyWorkRoot, { recursive: true, force: true }))
}

const outputRelativePathFor = (relativeInputPath: string): string => {
  const safePath = requireSafeRelativePath(relativeInputPath)
  const extension = path.posix.extname(safePath)
  return `${extension ? safePath.slice(0, -extension.length) : safePath}.png`
}

const collisionKey = (relativePath: string): string =>
  relativePath.normalize('NFC').toLocaleLowerCase('en-US')

const atomicWriteFile = async (
  anchor: string,
  targetPath: string,
  data: string | Buffer,
  label: string
): Promise<void> => {
  await ensureSecureDirectory(anchor, path.dirname(targetPath), label)
  await assertNoSymbolicLinkComponents(anchor, targetPath, label)
  const tempPath = path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  )
  await assertNoSymbolicLinkComponents(anchor, tempPath, label)
  try {
    await runBoundedFsOp(async () => {
      const handle = await fs.open(tempPath, 'wx')
      try {
        await handle.writeFile(data)
        await handle.sync()
      } finally {
        await handle.close()
      }
    })
    await assertNoSymbolicLinkComponents(anchor, targetPath, label)
    await assertNoSymbolicLinkComponents(anchor, tempPath, label)
    await runBoundedFsOp(() => renameWithWindowsRetry(tempPath, targetPath))
  } finally {
    await runBoundedFsOp(() => fs.rm(tempPath, { force: true })).catch(() => undefined)
  }
}

const isBatchManifest = (value: unknown): value is BatchManifest => {
  if (!value || typeof value !== 'object') return false
  const manifest = value as Partial<BatchManifest>
  return (
    manifest.version === BATCH_MANIFEST_VERSION &&
    typeof manifest.sourceRoot === 'string' &&
    typeof manifest.createdAt === 'string' &&
    typeof manifest.updatedAt === 'string' &&
    Array.isArray(manifest.items) &&
    manifest.items.every(
      (item) =>
        item &&
        typeof item.relativeInputPath === 'string' &&
        typeof item.outputRelativePath === 'string' &&
        item.sourceFingerprint &&
        typeof item.sourceFingerprint.size === 'number' &&
        typeof item.sourceFingerprint.mtimeMs === 'number' &&
        ['pending', 'running', 'succeeded', 'failed'].includes(item.status) &&
        Array.isArray(item.attempts)
    )
  )
}

const normalizePng = (image: Uint8Array): Buffer => {
  const bytes = Buffer.from(image)
  const decoded = nativeImage.createFromBuffer(bytes)
  if (decoded.isEmpty()) throw new Error('Batch result is not a decodable image')
  if (bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return bytes
  const png = decoded.toPNG()
  if (!png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error('Batch result could not be converted to PNG')
  }
  return png
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

  scanBatchImages = async (req: ScanBatchImagesReq): Promise<ScanBatchImagesResp> => {
    const sourceRoot = await canonicalizeBatchSourceRoot(req.sourceRoot)
    const images: BatchImageFile[] = []
    const errors: ScanBatchImagesResp['errors'] = []
    const directoriesToScan = [sourceRoot]
    const excludedDirectoryNames = new Set([BATCH_METADATA_DIR])

    while (directoriesToScan.length > 0) {
      const currentDir = directoriesToScan.shift()
      if (!currentDir) continue
      await assertNoSymbolicLinkComponents(sourceRoot, currentDir, 'batch source directory')
      const entries = await runBoundedFsOp(() => fs.readdir(currentDir, { withFileTypes: true }))
      entries.sort((left, right) => left.name.localeCompare(right.name))

      for (const entry of entries) {
        const absolutePath = path.join(currentDir, entry.name)
        const relativePath = toPortableRelativePath(path.relative(sourceRoot, absolutePath))
        const entryStats = await runBoundedFsOp(() => fs.lstat(absolutePath))
        if (entry.isSymbolicLink() || entryStats.isSymbolicLink()) {
          throw new Error(
            `Batch source entries cannot be symbolic links or junctions: ${relativePath}`
          )
        }
        if (entryStats.isDirectory()) {
          if (!excludedDirectoryNames.has(entry.name.toLocaleLowerCase('en-US'))) {
            directoriesToScan.push(absolutePath)
          }
          continue
        }
        if (
          !entryStats.isFile() ||
          !IMAGE_EXTENSIONS.includes(path.extname(entry.name).toLowerCase())
        ) {
          continue
        }

        const canonicalImagePath = await resolveCanonicalBatchSourcePath(sourceRoot, relativePath)
        try {
          const stats = await runBoundedFsOp(() => fs.lstat(canonicalImagePath))
          if (!stats.isFile() || stats.isSymbolicLink()) {
            throw new Error(`Batch source image is not a regular file: ${relativePath}`)
          }
          images.push({
            relativePath,
            absolutePath: canonicalImagePath,
            size: stats.size,
            mtimeMs: stats.mtimeMs
          })
        } catch (error) {
          errors.push({
            relativePath,
            message: error instanceof Error ? error.message : String(error)
          })
        }
      }
    }

    images.sort((left, right) => left.relativePath.localeCompare(right.relativePath))
    return { images, errors }
  }

  readBatchManifest = async (req: ReadBatchManifestReq): Promise<ReadBatchManifestResp> => {
    const paths = await getBatchWorkspacePaths(req.sourceRoot)
    await migrateLegacyBatchWorkspace(paths)
    try {
      await assertNoSymbolicLinkComponents(
        path.dirname(paths.sourceRoot),
        paths.manifestPath,
        'batch manifest'
      )
      const manifestStats = await runBoundedFsOp(() => fs.lstat(paths.manifestPath))
      if (!manifestStats.isFile() || manifestStats.isSymbolicLink()) {
        throw new Error(`Batch manifest is not a regular file: ${paths.manifestPath}`)
      }
      const text = await runBoundedFsOp(() => fs.readFile(paths.manifestPath, 'utf8'))
      const parsed: unknown = JSON.parse(text)
      if (!isBatchManifest(parsed)) {
        throw new Error(`Unsupported or invalid batch manifest: ${paths.manifestPath}`)
      }
      if ((await canonicalizeBatchSourceRoot(parsed.sourceRoot)) !== paths.sourceRoot) {
        throw new Error('Batch manifest sourceRoot does not match the requested source')
      }
      return { manifest: parsed, manifestPath: paths.manifestPath }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { manifest: null, manifestPath: paths.manifestPath }
      }
      throw error
    }
  }

  writeBatchManifest = async (req: WriteBatchManifestReq): Promise<WriteBatchManifestResp> => {
    const paths = await getBatchWorkspacePaths(req.sourceRoot)
    await migrateLegacyBatchWorkspace(paths)
    if (!isBatchManifest(req.manifest)) throw new Error('Invalid batch manifest')
    if ((await canonicalizeBatchSourceRoot(req.manifest.sourceRoot)) !== paths.sourceRoot) {
      throw new Error('Batch manifest sourceRoot does not match the requested source')
    }
    const manifest = { ...req.manifest, updatedAt: new Date().toISOString() }
    await atomicWriteFile(
      path.dirname(paths.sourceRoot),
      paths.manifestPath,
      `${JSON.stringify(manifest, null, 2)}\n`,
      'batch manifest'
    )
    return { manifestPath: paths.manifestPath }
  }

  prepareBatchWorkspace = async (
    req: PrepareBatchWorkspaceReq
  ): Promise<PrepareBatchWorkspaceResp> => {
    const paths = await getBatchWorkspacePaths(req.sourceRoot)
    const { images, errors: scanErrors } = await this.scanBatchImages({
      sourceRoot: paths.sourceRoot
    })
    const collisions = new Map<string, string[]>()
    for (const image of images) {
      const outputRelativePath = outputRelativePathFor(image.relativePath)
      const key = collisionKey(outputRelativePath)
      const entries = collisions.get(key) ?? []
      entries.push(image.relativePath)
      collisions.set(key, entries)
    }
    const conflicting = [...collisions.entries()].filter(([, inputs]) => inputs.length > 1)
    if (conflicting.length > 0) {
      throw new Error(
        `Batch PNG output path collision: ${conflicting
          .map(([output, inputs]) => `${inputs.join(', ')} -> ${output}`)
          .join('; ')}`
      )
    }

    await migrateLegacyBatchWorkspace(paths)
    const workspaceAnchor = path.dirname(paths.sourceRoot)
    await ensureSecureDirectory(workspaceAnchor, paths.outputRoot, 'batch outputRoot')
    await ensureSecureDirectory(workspaceAnchor, paths.metadataRoot, 'batch metadataRoot')
    await ensureSecureDirectory(workspaceAnchor, paths.stagingRoot, 'batch staging')

    const existing = (await this.readBatchManifest({ sourceRoot: paths.sourceRoot })).manifest
    const existingItems = new Map(
      existing?.items.map((item) => [item.relativeInputPath, item]) ?? []
    )
    const now = new Date().toISOString()
    const preparedItems = await Promise.all(
      images.map(async (image) => {
        const previous = existingItems.get(image.relativePath)
        const outputRelativePath = outputRelativePathFor(image.relativePath)
        const fingerprintMatches =
          previous?.sourceFingerprint.size === image.size &&
          previous.sourceFingerprint.mtimeMs === image.mtimeMs
        const finalOutputPath = await resolveSafeBatchPath(paths.outputRoot, outputRelativePath)
        const canSkip =
          previous?.status === 'succeeded' &&
          fingerprintMatches &&
          (await isBatchOutputValid(finalOutputPath))
        if (canSkip) {
          return { item: previous, skippedRelativePath: image.relativePath }
        }

        const previousOutputRelativePath = previous?.outputRelativePath
        if (previousOutputRelativePath && previousOutputRelativePath !== outputRelativePath) {
          const previousOutputPath = await resolveSafeBatchPath(
            paths.outputRoot,
            previousOutputRelativePath
          )
          await runBoundedFsOp(() => fs.rm(previousOutputPath, { force: true }))
        }
        await assertNoSymbolicLinkComponents(paths.outputRoot, finalOutputPath, 'batch output')
        await runBoundedFsOp(() => fs.rm(finalOutputPath, { force: true }))
        await ensureSecureDirectory(
          path.dirname(paths.sourceRoot),
          path.dirname(finalOutputPath),
          'batch output'
        )
        return {
          item: {
            relativeInputPath: image.relativePath,
            outputRelativePath,
            sourceFingerprint: { size: image.size, mtimeMs: image.mtimeMs },
            status: 'pending' as const,
            quickAppId: previous?.quickAppId,
            quickAppRevision: previous?.quickAppRevision,
            attempts: previous?.attempts ?? []
          }
        }
      })
    )
    const items = preparedItems.map(({ item }) => item)
    const skippedRelativePaths = preparedItems.flatMap(({ skippedRelativePath }) =>
      skippedRelativePath ? [skippedRelativePath] : []
    )

    const manifest: BatchManifest = {
      version: BATCH_MANIFEST_VERSION,
      sourceRoot: paths.sourceRoot,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      items
    }
    await this.writeBatchManifest({ sourceRoot: paths.sourceRoot, manifest })
    return {
      paths,
      manifest: { ...manifest, updatedAt: manifest.updatedAt },
      images,
      skippedRelativePaths,
      scanErrors
    }
  }

  readBatchSourceImage = async (
    req: ReadBatchSourceImageReq
  ): Promise<ReadBatchSourceImageResp> => {
    const paths = await getBatchWorkspacePaths(req.sourceRoot)
    const relativeInputPath = requireSafeRelativePath(req.relativeInputPath)
    const bytes = await readVerifiedBatchSource(
      paths.sourceRoot,
      relativeInputPath,
      req.sourceFingerprint,
      true
    )
    if (!bytes) throw new Error('Batch source image could not be read')
    return { image: new Uint8Array(bytes), filename: path.basename(relativeInputPath) }
  }

  commitBatchPng = async (req: CommitBatchPngReq): Promise<CommitBatchPngResp> => {
    requireBoundedPayload(req.image, MAX_FULL_FILE_BYTES, 'Image')
    const paths = await getBatchWorkspacePaths(req.sourceRoot)
    const relativeInputPath = requireSafeRelativePath(req.relativeInputPath)
    const outputRelativePath = outputRelativePathFor(relativeInputPath)
    const stagingPath = await resolveSafeBatchPath(paths.stagingRoot, outputRelativePath)
    const outputPath = await resolveSafeBatchPath(paths.outputRoot, outputRelativePath)
    const png = normalizePng(req.image)

    const errorLogPath = await resolveSafeBatchPath(
      paths.metadataRoot,
      path.posix.join(BATCH_ERRORS_DIR, `${relativeInputPath}.log`)
    )
    await readVerifiedBatchSource(paths.sourceRoot, relativeInputPath, req.sourceFingerprint, false)

    const workspaceAnchor = path.dirname(paths.sourceRoot)
    try {
      await atomicWriteFile(workspaceAnchor, stagingPath, png, 'batch staging output')
      await atomicWriteFile(workspaceAnchor, outputPath, png, 'batch output')
      if (!(await isBatchOutputValid(outputPath))) throw new Error('Committed batch PNG is invalid')
    } catch (error) {
      await runBoundedFsOp(() => fs.rm(outputPath, { force: true }))
      throw error
    } finally {
      await runBoundedFsOp(() => fs.rm(stagingPath, { force: true }))
    }

    await runBoundedFsOp(() => fs.rm(errorLogPath, { force: true }))
    return { outputRelativePath, outputPath }
  }

  removeBatchStagingArtifacts = async (
    req: RemoveBatchStagingArtifactsReq
  ): Promise<RemoveBatchStagingArtifactsResp> => {
    const paths = await getBatchWorkspacePaths(req.sourceRoot)
    const stagingPath = await resolveSafeBatchPath(
      paths.stagingRoot,
      outputRelativePathFor(req.relativeInputPath)
    )
    const stagingDirectory = path.dirname(stagingPath)
    const stagingPrefix = `.${path.basename(stagingPath)}.tmp-`
    const removedPaths: string[] = []
    if (await pathExists(stagingPath)) {
      await runBoundedFsOp(() => fs.rm(stagingPath, { force: true }))
      removedPaths.push(stagingPath)
    }
    const entries = await runBoundedFsOp(() => fs.readdir(stagingDirectory)).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return []
        throw error
      }
    )
    for (const entry of entries) {
      if (!entry.startsWith(stagingPrefix)) continue
      const tempPath = path.join(stagingDirectory, entry)
      await runBoundedFsOp(() => fs.rm(tempPath, { force: true }))
      removedPaths.push(tempPath)
    }
    return { removedPaths }
  }

  appendBatchAggregateError = async (req: {
    sourceRoot: string
    entry: string
  }): Promise<{ errorLogPath: string }> => {
    const paths = await getBatchWorkspacePaths(req.sourceRoot)
    const errorLogPath = await resolveSafeBatchPath(paths.metadataRoot, 'errors.log')
    await runBoundedFsOp(() => fs.mkdir(paths.metadataRoot, { recursive: true }))
    await assertNoSymbolicLinkComponents(
      paths.metadataRoot,
      errorLogPath,
      'batch aggregate error log'
    )

    const flags =
      fsConstants.O_WRONLY |
      fsConstants.O_CREAT |
      fsConstants.O_APPEND |
      (fsConstants.O_NOFOLLOW ?? 0)
    const handle = await runBoundedFsOp(() => fs.open(errorLogPath, flags, 0o600))
    try {
      const stats = await handle.stat()
      if (!stats.isFile()) throw new Error('Batch aggregate error log must be a regular file')
      await handle.writeFile(req.entry, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    return { errorLogPath }
  }

  failBatchItem = async (req: FailBatchItemReq): Promise<FailBatchItemResp> => {
    const paths = await getBatchWorkspacePaths(req.sourceRoot)
    const relativeInputPath = requireSafeRelativePath(req.relativeInputPath)
    const outputPngPath = await resolveSafeBatchPath(
      paths.outputRoot,
      outputRelativePathFor(relativeInputPath)
    )
    const errorLogPath = await resolveSafeBatchPath(
      paths.metadataRoot,
      path.posix.join(BATCH_ERRORS_DIR, `${relativeInputPath}.log`)
    )
    const removedOutputPaths: string[] = []
    for (const candidate of [outputPngPath]) {
      if (await pathExists(candidate)) {
        await runBoundedFsOp(() => fs.rm(candidate, { force: true }))
        removedOutputPaths.push(candidate)
      }
    }
    await atomicWriteFile(
      path.dirname(paths.sourceRoot),
      errorLogPath,
      req.errorLog,
      'batch error log'
    )
    await this.removeBatchStagingArtifacts({ sourceRoot: req.sourceRoot, relativeInputPath })
    return { errorLogPath, removedOutputPaths }
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
    const fullPath = resolveAuthorizedLocalMediaPath(req.fullPath, [
      app.getPath('userData'),
      path.join(app.getPath('temp'), 'magicpot-local-media'),
      storageState.projectRoot,
      storageState.autoSaveRoot
    ])

    if (!fullPath) {
      throw new Error('Local image path is not authorized')
    }

    if (!(await pathExists(fullPath))) {
      throw new Error(`File not found: ${fullPath}`)
    }

    await assertReadableFileWithinLimit(fullPath, MAX_FULL_FILE_BYTES)
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
        await fs.writeFile(tempPath, content, 'utf8')
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
