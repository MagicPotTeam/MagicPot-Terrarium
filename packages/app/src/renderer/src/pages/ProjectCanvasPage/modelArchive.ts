import JSZip from 'jszip'
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

const stripCommonLeadingDirectories = (entries: ModelPackageFileEntry[]) => {
  if (entries.length === 0) return entries

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

export const listContainedModelExtensions = (entries: ModelPackageFileEntry[]): string[] => {
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
  const normalizedEntries = stripCommonLeadingDirectories(entries).filter(
    (entry) => entry.path && entry.file
  )
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
  const linkedAssets: Record<string, string> = {}

  for (const entry of normalizedEntries) {
    if (
      !shouldIncludeAssetEntry(entry.path, selectedModelEntry.path, modelPaths, includeAllFiles)
    ) {
      continue
    }

    linkedAssets[entry.path] = URL.createObjectURL(entry.file)
  }

  return {
    file: selectedModelEntry.file,
    linkedAssets,
    sourcePath: selectedModelEntry.path
  }
}

export async function extractModelArchive(
  file: File,
  allowedExtensions: readonly string[] = MODEL_3D_EXTENSIONS
): Promise<ExtractedModelArchive | null> {
  if (!isModelArchiveFile(file.name)) return null

  const zip = await JSZip.loadAsync(file)
  const entries = Object.values(zip.files).filter((entry) => !entry.dir)
  const packageEntries: ModelPackageFileEntry[] = []
  const createdUrls: string[] = []

  try {
    for (const entry of entries) {
      const blob = await entry.async('blob')
      packageEntries.push({
        path: normalizeArchivePath(entry.name),
        file: new File([blob], getBaseName(entry.name), {
          type: blob.type || 'application/octet-stream'
        })
      })
    }

    const extracted = extractModelPackageFiles(packageEntries, file.name, allowedExtensions)
    if (!extracted) {
      throw new ModelPackageUnsupportedFormatError(listContainedModelExtensions(packageEntries))
    }

    Object.values(extracted.linkedAssets).forEach((url) => createdUrls.push(url))
    return extracted
  } catch (error) {
    createdUrls.forEach((url) => URL.revokeObjectURL(url))
    throw error
  }
}
