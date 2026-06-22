import type JSZip from 'jszip'
import { MODEL_3D_EXTENSIONS, getFileExtension, isModelArchiveFile } from './types'

export type ExtractedModelArchive = {
  file: File
  linkedAssets: Record<string, string>
  sourcePath: string
}

export type ModelPackageFileEntry = {
  path: string
  file: File
}

export type ModelArchiveLimitKind = 'archiveSize' | 'entryCount' | 'totalExtractedSize'

export type ModelArchiveLimits = {
  maxArchiveBytes: number
  maxEntries: number
  maxTotalExtractedBytes: number
}

export const MODEL_ARCHIVE_DEFAULT_LIMITS: ModelArchiveLimits = {
  maxArchiveBytes: 512 * 1024 * 1024,
  maxEntries: 4096,
  maxTotalExtractedBytes: 1024 * 1024 * 1024
}

export class ModelArchiveLimitExceededError extends Error {
  limitKind: ModelArchiveLimitKind
  limit: number
  actual: number

  constructor(limitKind: ModelArchiveLimitKind, limit: number, actual: number) {
    super(`Model archive ${limitKind} exceeds safety limit (${actual} > ${limit})`)
    this.name = 'ModelArchiveLimitExceededError'
    this.limitKind = limitKind
    this.limit = limit
    this.actual = actual
  }
}

export class ModelArchiveMalformedError extends Error {
  cause?: unknown

  constructor(message = 'Model archive is malformed or could not be read', cause?: unknown) {
    super(message)
    this.name = 'ModelArchiveMalformedError'
    this.cause = cause
  }
}

export class ModelPackageUnsupportedFormatError extends Error {
  detectedModelExtensions: string[]

  constructor(detectedModelExtensions: string[]) {
    super('Package does not contain a model in one of the currently allowed formats')
    this.name = 'ModelPackageUnsupportedFormatError'
    this.detectedModelExtensions = detectedModelExtensions
  }
}

const MODEL_EXTENSION_PRIORITY: Record<string, number> = {
  '.fbx': 500,
  '.glb': 400,
  '.gltf': 300,
  '.obj': 200,
  '.stl': 100
}

const MODEL_ASSET_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.bmp',
  '.tga',
  '.dds',
  '.hdr',
  '.exr',
  '.webp',
  '.gif',
  '.tiff',
  '.tif',
  '.mtl',
  '.mat',
  '.bin',
  '.json',
  '.ktx2',
  '.basis'
])

const MODEL_EXTENSION_ORDER = new Map(
  MODEL_3D_EXTENSIONS.map((extension, index) => [extension, index])
)

type ModelPackagePathEntry = {
  path: string
}

type SelectedModelPackageEntries<T extends ModelPackagePathEntry> = {
  selectedModelEntry: T
  linkedAssetEntries: T[]
}

type ZipEntrySizeData = {
  uncompressedSize?: number
}

type JSZipObjectWithSize = JSZip.JSZipObject & {
  _data?: ZipEntrySizeData
}

type JSZipObjectWithInternalStream = JSZip.JSZipObject & {
  internalStream?: (type: 'uint8array') => JSZip.JSZipStreamHelper<Uint8Array>
}

type ModelArchiveZipEntry = {
  path: string
  entry: JSZip.JSZipObject
  uncompressedSize: number
}

const normalizeArchivePath = (value: string) => value.replace(/\\/g, '/').replace(/^\/+/, '')

const getBaseName = (value: string) => {
  const normalized = normalizeArchivePath(value)
  const lastSlash = normalized.lastIndexOf('/')
  return lastSlash >= 0 ? normalized.slice(lastSlash + 1) : normalized
}

const getDirName = (value: string) => {
  const normalized = normalizeArchivePath(value)
  const lastSlash = normalized.lastIndexOf('/')
  return lastSlash >= 0 ? normalized.slice(0, lastSlash) : ''
}

const getStem = (value: string) => {
  const baseName = getBaseName(value)
  const extension = getFileExtension(baseName)
  return extension ? baseName.slice(0, -extension.length) : baseName
}

const stripCommonLeadingDirectories = <T extends ModelPackagePathEntry>(
  entries: readonly T[]
): T[] => {
  if (entries.length === 0) return []

  const segmentedPaths = entries.map((entry) =>
    normalizeArchivePath(entry.path).split('/').filter(Boolean)
  )
  const minSegmentLength = Math.min(...segmentedPaths.map((segments) => segments.length))
  let commonDepth = 0

  while (commonDepth < minSegmentLength - 1) {
    const currentSegment = segmentedPaths[0][commonDepth]
    if (
      !currentSegment ||
      segmentedPaths.some((segments) => segments[commonDepth] !== currentSegment)
    ) {
      break
    }
    commonDepth += 1
  }

  if (commonDepth === 0) {
    return entries.map((entry) => ({ ...entry, path: normalizeArchivePath(entry.path) }))
  }

  return entries.map((entry) => {
    const normalizedPath = normalizeArchivePath(entry.path)
    const nextPath = normalizedPath.split('/').filter(Boolean).slice(commonDepth).join('/')

    return {
      ...entry,
      path: nextPath || getBaseName(normalizedPath)
    }
  })
}

const scoreModelEntry = (entryPath: string, packageStem: string) => {
  const normalized = normalizeArchivePath(entryPath)
  const extension = getFileExtension(normalized)
  const baseName = getBaseName(normalized)
  const stem = getStem(normalized)
  const depth = normalized.split('/').length - 1
  const priority = MODEL_EXTENSION_PRIORITY[extension] || 0
  const sameStem = stem.toLowerCase() === packageStem.toLowerCase() ? 1000 : 0
  const sameBaseName = baseName.toLowerCase() === packageStem.toLowerCase() ? 1000 : 0

  return sameBaseName + sameStem + priority - depth * 10
}

const shouldIncludeAssetEntry = (
  entryPath: string,
  modelPath: string,
  modelPaths: string[],
  includeAllFiles: boolean
) => {
  const normalizedEntryPath = normalizeArchivePath(entryPath)
  const normalizedModelPath = normalizeArchivePath(modelPath)
  if (normalizedEntryPath === normalizedModelPath) return false
  if (modelPaths.includes(normalizedEntryPath)) return false
  if (!MODEL_ASSET_EXTENSIONS.has(getFileExtension(normalizedEntryPath))) return false
  if (includeAllFiles) return true

  const modelDir = getDirName(normalizedModelPath)
  const modelStem = getStem(normalizedModelPath)
  const entryDir = getDirName(normalizedEntryPath)
  const siblingFbmDir = modelDir ? `${modelDir}/${modelStem}.fbm/` : `${modelStem}.fbm/`

  return entryDir === modelDir || normalizedEntryPath.startsWith(siblingFbmDir)
}

const selectModelPackageEntries = <T extends ModelPackagePathEntry>(
  entries: readonly T[],
  packageName = 'package',
  allowedExtensions: readonly string[] = MODEL_3D_EXTENSIONS
): SelectedModelPackageEntries<T> | null => {
  const normalizedEntries = stripCommonLeadingDirectories(entries).filter((entry) => entry.path)
  const modelEntries = normalizedEntries.filter((entry) =>
    allowedExtensions.includes(getFileExtension(entry.path))
  )

  if (modelEntries.length === 0) {
    return null
  }

  const packageStem = getStem(packageName).replace(/\.fbm$/i, '')
  const modelPaths = modelEntries.map((entry) => entry.path)
  const selectedModelEntry = [...modelEntries].sort(
    (left, right) =>
      scoreModelEntry(right.path, packageStem) - scoreModelEntry(left.path, packageStem)
  )[0]
  const includeAllFiles = modelEntries.length === 1
  const linkedAssetEntries = normalizedEntries.filter((entry) =>
    shouldIncludeAssetEntry(entry.path, selectedModelEntry.path, modelPaths, includeAllFiles)
  )

  return {
    selectedModelEntry,
    linkedAssetEntries
  }
}

type ModelPackageExtensionEntry = ModelPackagePathEntry | ModelPackageFileEntry

export const listContainedModelExtensions = (
  entries: readonly ModelPackageExtensionEntry[]
): string[] => {
  const extensions = new Set<string>()

  for (const entry of stripCommonLeadingDirectories(entries)) {
    const extension = getFileExtension(entry.path)
    if (MODEL_3D_EXTENSIONS.includes(extension)) {
      extensions.add(extension)
    }
  }

  return [...extensions].sort((left, right) => {
    const leftOrder = MODEL_EXTENSION_ORDER.get(left) ?? Number.MAX_SAFE_INTEGER
    const rightOrder = MODEL_EXTENSION_ORDER.get(right) ?? Number.MAX_SAFE_INTEGER
    return leftOrder - rightOrder
  })
}

export function extractModelPackageFiles(
  entries: ModelPackageFileEntry[],
  packageName = 'package',
  allowedExtensions: readonly string[] = MODEL_3D_EXTENSIONS
): ExtractedModelArchive | null {
  const selectedEntries = selectModelPackageEntries(
    entries.filter((entry) => entry.path && entry.file),
    packageName,
    allowedExtensions
  )

  if (!selectedEntries) {
    return null
  }

  const linkedAssets: Record<string, string> = {}

  for (const entry of selectedEntries.linkedAssetEntries) {
    linkedAssets[entry.path] = URL.createObjectURL(entry.file)
  }

  return {
    file: selectedEntries.selectedModelEntry.file,
    linkedAssets,
    sourcePath: selectedEntries.selectedModelEntry.path
  }
}

const resolveModelArchiveLimits = (limits?: Partial<ModelArchiveLimits>): ModelArchiveLimits => ({
  maxArchiveBytes: limits?.maxArchiveBytes ?? MODEL_ARCHIVE_DEFAULT_LIMITS.maxArchiveBytes,
  maxEntries: limits?.maxEntries ?? MODEL_ARCHIVE_DEFAULT_LIMITS.maxEntries,
  maxTotalExtractedBytes:
    limits?.maxTotalExtractedBytes ?? MODEL_ARCHIVE_DEFAULT_LIMITS.maxTotalExtractedBytes
})

const assertModelArchiveLimit = (
  limitKind: ModelArchiveLimitKind,
  actual: number,
  limit: number
) => {
  if (actual > limit) {
    throw new ModelArchiveLimitExceededError(limitKind, limit, actual)
  }
}

const getZipEntryUncompressedSize = (entry: JSZip.JSZipObject) => {
  const uncompressedSize = (entry as JSZipObjectWithSize)._data?.uncompressedSize

  if (
    typeof uncompressedSize !== 'number' ||
    !Number.isFinite(uncompressedSize) ||
    uncompressedSize < 0
  ) {
    throw new ModelArchiveMalformedError(
      `Model archive entry "${entry.name}" is missing valid size metadata`
    )
  }

  return uncompressedSize
}

const readModelArchiveZip = async (file: File) => {
  try {
    const { default: JSZipCtor } = await import('jszip')
    return await JSZipCtor.loadAsync(file)
  } catch (error) {
    throw new ModelArchiveMalformedError('Model archive is malformed or could not be read', error)
  }
}

const getModelArchiveZipEntries = (
  zip: JSZip,
  limits: ModelArchiveLimits
): ModelArchiveZipEntry[] => {
  const allEntries = Object.values(zip.files)
  assertModelArchiveLimit('entryCount', allEntries.length, limits.maxEntries)

  const archiveEntries: ModelArchiveZipEntry[] = []
  let totalExtractedSize = 0

  for (const entry of allEntries) {
    if (entry.dir) continue

    const uncompressedSize = getZipEntryUncompressedSize(entry)
    totalExtractedSize += uncompressedSize
    assertModelArchiveLimit('totalExtractedSize', totalExtractedSize, limits.maxTotalExtractedBytes)
    archiveEntries.push({
      path: normalizeArchivePath(entry.name),
      entry,
      uncompressedSize
    })
  }

  return archiveEntries
}

const extractZipEntryFile = async (archiveEntry: ModelArchiveZipEntry) => {
  const chunks: Uint8Array[] = []
  let extractedSize = 0

  try {
    const entryWithInternalStream = archiveEntry.entry as JSZipObjectWithInternalStream
    const stream = entryWithInternalStream.internalStream?.('uint8array')

    if (!stream) {
      const blob = await archiveEntry.entry.async('blob')
      if (blob.size > archiveEntry.uncompressedSize) {
        throw new ModelArchiveMalformedError(
          `Model archive entry "${archiveEntry.path}" expanded beyond its declared size`
        )
      }
      return new File([blob], getBaseName(archiveEntry.path), {
        type: blob.type || 'application/octet-stream'
      })
    }

    await new Promise<void>((resolve, reject) => {
      stream
        .on('data', (chunk) => {
          extractedSize += chunk.byteLength
          if (extractedSize > archiveEntry.uncompressedSize) {
            stream.pause()
            reject(
              new ModelArchiveMalformedError(
                `Model archive entry "${archiveEntry.path}" expanded beyond its declared size`
              )
            )
            return
          }
          chunks.push(chunk)
        })
        .on('error', reject)
        .on('end', resolve)
        .resume()
    })
  } catch (error) {
    if (error instanceof ModelArchiveMalformedError) {
      throw error
    }
    throw new ModelArchiveMalformedError(
      `Model archive entry "${archiveEntry.path}" could not be extracted`,
      error
    )
  }

  const fileParts: BlobPart[] = chunks.map((chunk) => {
    const copy = new Uint8Array(chunk.byteLength)
    copy.set(chunk)
    return copy as Uint8Array<ArrayBuffer>
  })

  return new File(fileParts, getBaseName(archiveEntry.path), {
    type: 'application/octet-stream'
  })
}

export async function extractModelArchive(
  file: File,
  allowedExtensions: readonly string[] = MODEL_3D_EXTENSIONS,
  limits?: Partial<ModelArchiveLimits>
): Promise<ExtractedModelArchive | null> {
  if (!isModelArchiveFile(file.name)) return null

  const resolvedLimits = resolveModelArchiveLimits(limits)
  assertModelArchiveLimit('archiveSize', file.size, resolvedLimits.maxArchiveBytes)

  const zip = await readModelArchiveZip(file)
  const archiveEntries = getModelArchiveZipEntries(zip, resolvedLimits)
  const selectedEntries = selectModelPackageEntries(archiveEntries, file.name, allowedExtensions)

  if (!selectedEntries) {
    throw new ModelPackageUnsupportedFormatError(listContainedModelExtensions(archiveEntries))
  }

  const createdUrls: string[] = []

  try {
    const selectedModelFile = await extractZipEntryFile(selectedEntries.selectedModelEntry)
    const linkedAssets: Record<string, string> = {}

    for (const entry of selectedEntries.linkedAssetEntries) {
      const assetFile = await extractZipEntryFile(entry)
      const url = URL.createObjectURL(assetFile)
      createdUrls.push(url)
      linkedAssets[entry.path] = url
    }

    return {
      file: selectedModelFile,
      linkedAssets,
      sourcePath: selectedEntries.selectedModelEntry.path
    }
  } catch (error) {
    createdUrls.forEach((url) => URL.revokeObjectURL(url))
    throw error
  }
}
