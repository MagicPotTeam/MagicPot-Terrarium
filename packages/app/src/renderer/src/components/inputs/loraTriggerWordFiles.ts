import { api } from '@renderer/utils/windowUtils'
import type { ConfigUtils } from '@shared/config/configUtils'
import type { BuiltInPath } from '@shared/utils/utilWindow'
import { normalizeTriggerWords } from './loraTriggerWords'

export type LoraModelFileRef = {
  outputPath: string
  filename: string
  fullPath: string
}

export type LoraTriggerWordsFileRef = {
  outputPath: string
  filename: string
  fullPath: string
}

type LoraTriggerWordsSidecarKind = 'text' | 'metadata'

type LoraTriggerWordsSidecarFileRef = LoraTriggerWordsFileRef & {
  kind: LoraTriggerWordsSidecarKind
}

const LORA_MODEL_FILE_EXTENSIONS = ['.safetensors', '.ckpt', '.pt', '.pth', '.bin']
const SAFETENSORS_EXTENSION = '.safetensors'
const TRIGGER_WORDS_TEXT_EXTENSION = '.txt'
const METADATA_SIDECAR_SUFFIXES = ['.civitai.info', '.metadata.json', '.json']
const MAX_TRIGGER_WORD_SEARCH_DEPTH = 6
const COMFYUI_LORA_MODEL_FOLDER = 'loras'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const hasParentTraversal = (relativePath: string): boolean =>
  relativePath.split(/[\\/]+/).some((segment) => segment === '..')

const isWindowsAbsolutePath = (value: string): boolean => /^[a-zA-Z]:[\\/]/.test(value)

const normalizeSelectedLoraName = (loraName: string): string | null => {
  const trimmedName = loraName.trim()
  if (!trimmedName || trimmedName.startsWith('/') || trimmedName.startsWith('\\')) {
    return null
  }
  if (isWindowsAbsolutePath(trimmedName)) {
    return null
  }

  const segments = trimmedName.split(/[\\/]+/).filter(Boolean)
  if (segments.length === 0 || segments.some((segment) => segment === '..')) {
    return null
  }

  return segments.join('/')
}

const getPortablePathExtension = (portablePath: string): string => {
  const filename = portablePath.split('/').pop() || ''
  const dotIndex = filename.lastIndexOf('.')
  return dotIndex > 0 ? filename.slice(dotIndex).toLocaleLowerCase() : ''
}

const uniqueByFullPath = <T extends { fullPath: string }>(refs: T[]): T[] => {
  const seen = new Set<string>()
  const deduped: T[] = []
  for (const ref of refs) {
    const key = ref.fullPath.toLocaleLowerCase()
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    deduped.push(ref)
  }
  return deduped
}

export const toLoraOptionName = (
  loraDir: string,
  filePath: string,
  pathApi: BuiltInPath = window.path
): string | null => {
  const baseDir = pathApi.normalize(loraDir.trim())
  const normalizedPath = pathApi.normalize(filePath.trim())
  if (!baseDir || !normalizedPath) {
    return null
  }

  const relativePath = pathApi.relative(baseDir, normalizedPath)
  if (!relativePath || pathApi.isAbsolute(relativePath) || hasParentTraversal(relativePath)) {
    return null
  }

  return relativePath
    .split(/[\\/]+/)
    .filter(Boolean)
    .join('/')
}

export const listLoraModelOptions = async (configUtils: ConfigUtils): Promise<string[]> => {
  const loraDir = configUtils.getLoraDir()
  if (!loraDir) {
    return []
  }

  try {
    const response = await api().svcFs.listFilesInFolder({
      folderPath: loraDir,
      extensions: LORA_MODEL_FILE_EXTENSIONS,
      recursive: true
    })

    return Array.from(
      new Set(
        response.files
          .map((file) => toLoraOptionName(loraDir, file.fullPath))
          .filter((file): file is string => Boolean(file))
      )
    ).sort((left, right) => left.localeCompare(right))
  } catch (error) {
    console.warn('[LoRA] failed to list LoRA files from configured directory:', error)
    return []
  }
}

export const resolveLoraModelFile = (
  loraDir: string,
  loraName: string,
  pathApi: BuiltInPath = window.path
): LoraModelFileRef | null => {
  const baseDir = pathApi.normalize(loraDir.trim())
  const normalizedName = loraName.trim()

  if (!baseDir || !normalizedName || pathApi.isAbsolute(normalizedName)) {
    return null
  }

  const nameSegments = normalizedName.split(/[\\/]+/).filter(Boolean)
  if (nameSegments.some((segment) => segment === '..')) {
    return null
  }

  const fullPath = pathApi.normalize(pathApi.join(baseDir, ...nameSegments))
  const relativePath = pathApi.relative(baseDir, fullPath)
  if (!relativePath || pathApi.isAbsolute(relativePath) || hasParentTraversal(relativePath)) {
    return null
  }

  return {
    outputPath: pathApi.dirname(fullPath) || baseDir,
    filename: pathApi.basename(fullPath),
    fullPath
  }
}

const resolveLoraModelFileCandidates = (
  loraDir: string,
  loraName: string,
  pathApi: BuiltInPath = window.path
): LoraModelFileRef[] => {
  const baseModelFileRef = resolveLoraModelFile(loraDir, loraName, pathApi)
  if (!baseModelFileRef) {
    return []
  }

  const parsedName = pathApi.parse(baseModelFileRef.filename)
  const normalizedExt = (parsedName.ext || '').toLocaleLowerCase()
  const candidates = [baseModelFileRef]

  if (!LORA_MODEL_FILE_EXTENSIONS.includes(normalizedExt)) {
    candidates.push(
      ...LORA_MODEL_FILE_EXTENSIONS.map((extension) => {
        const filename = `${baseModelFileRef.filename}${extension}`
        return {
          outputPath: baseModelFileRef.outputPath,
          filename,
          fullPath: pathApi.join(baseModelFileRef.outputPath, filename)
        }
      })
    )
  }

  return uniqueByFullPath(candidates)
}

const sidecarRef = (
  modelFileRef: LoraModelFileRef,
  filename: string,
  kind: LoraTriggerWordsSidecarKind,
  pathApi: BuiltInPath
): LoraTriggerWordsSidecarFileRef => ({
  outputPath: modelFileRef.outputPath,
  filename,
  fullPath: pathApi.join(modelFileRef.outputPath, filename),
  kind
})

const resolveLoraTriggerWordsSidecarFiles = (
  loraDir: string,
  loraName: string,
  pathApi: BuiltInPath = window.path
): LoraTriggerWordsSidecarFileRef[] => {
  const modelFileRefs = resolveLoraModelFileCandidates(loraDir, loraName, pathApi)
  const sidecarRefs = modelFileRefs.flatMap((modelFileRef) => {
    const parsedName = pathApi.parse(modelFileRef.filename)
    const basenameCandidates = [parsedName.name]
    if (parsedName.ext) {
      basenameCandidates.push(modelFileRef.filename)
    }

    return basenameCandidates.flatMap((basename) => [
      sidecarRef(modelFileRef, `${basename}${TRIGGER_WORDS_TEXT_EXTENSION}`, 'text', pathApi),
      ...METADATA_SIDECAR_SUFFIXES.map((suffix) =>
        sidecarRef(modelFileRef, `${basename}${suffix}`, 'metadata', pathApi)
      )
    ])
  })

  return uniqueByFullPath(sidecarRefs)
}

export const resolveLoraTriggerWordsFile = (
  loraDir: string,
  loraName: string,
  pathApi: BuiltInPath = window.path
): LoraTriggerWordsFileRef | null => {
  const fileRef = resolveLoraTriggerWordsSidecarFiles(loraDir, loraName, pathApi).find(
    (candidate) => candidate.kind === 'text'
  )
  if (!fileRef) {
    return null
  }

  return {
    outputPath: fileRef.outputPath,
    filename: fileRef.filename,
    fullPath: fileRef.fullPath
  }
}

const parseJsonString = (value: string): unknown | null => {
  const trimmed = value.trim()
  if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) {
    return null
  }

  try {
    return JSON.parse(trimmed)
  } catch {
    return null
  }
}

const normalizeMetadataKey = (key: string): string =>
  key.toLocaleLowerCase().replace(/[^a-z0-9]+/g, '')

const isTriggerWordMetadataKey = (key: string): boolean => {
  const normalizedKey = normalizeMetadataKey(key)
  if (
    [
      'triggerword',
      'triggerwords',
      'triggerphrase',
      'triggerphrases',
      'triggertext',
      'triggers',
      'activationtag',
      'activationtags',
      'activationtext',
      'activationtexts',
      'activationkeyword',
      'activationkeywords',
      'activationphrase',
      'activationphrases',
      'trainedword',
      'trainedwords',
      'trainedtoken',
      'trainedtokens',
      'trainedtag',
      'trainedtags',
      'modelspectriggerphrase',
      'modelspectriggerphrases'
    ].includes(normalizedKey)
  ) {
    return true
  }

  return (
    (normalizedKey.includes('trigger') &&
      (normalizedKey.includes('word') ||
        normalizedKey.includes('phrase') ||
        normalizedKey.includes('tag') ||
        normalizedKey.includes('token') ||
        normalizedKey.includes('keyword') ||
        normalizedKey.includes('text'))) ||
    (normalizedKey.includes('activation') &&
      (normalizedKey.includes('word') ||
        normalizedKey.includes('phrase') ||
        normalizedKey.includes('tag') ||
        normalizedKey.includes('token') ||
        normalizedKey.includes('keyword') ||
        normalizedKey.includes('text')))
  )
}

const cleanTriggerWord = (value: string): string =>
  value
    .trim()
    .replace(/^["'`]+/, '')
    .replace(/["'`]+$/, '')
    .trim()

const normalizeTriggerWordCandidates = (candidates: string[]): string => {
  const deduped: string[] = []
  const seen = new Set<string>()

  for (const candidate of candidates) {
    for (const word of candidate.split(/[,;\r\n]+/)) {
      const normalizedWord = cleanTriggerWord(word)
      if (!normalizedWord) {
        continue
      }

      const key = normalizedWord.toLocaleLowerCase()
      if (seen.has(key)) {
        continue
      }
      seen.add(key)
      deduped.push(normalizedWord)
    }
  }

  return normalizeTriggerWords(deduped.join('\n'))
}

const collectStringsFromTriggerValue = (value: unknown, depth = 0): string[] => {
  if (depth > MAX_TRIGGER_WORD_SEARCH_DEPTH) {
    return []
  }

  if (typeof value === 'string') {
    const parsed = parseJsonString(value)
    if (parsed !== null) {
      return collectStringsFromTriggerValue(parsed, depth + 1)
    }
    return [value]
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => collectStringsFromTriggerValue(item, depth + 1))
  }

  if (isRecord(value)) {
    return Object.values(value).flatMap((item) => collectStringsFromTriggerValue(item, depth + 1))
  }

  return []
}

const collectExplicitTriggerWords = (value: unknown, depth = 0): string[] => {
  if (depth > MAX_TRIGGER_WORD_SEARCH_DEPTH) {
    return []
  }

  if (typeof value === 'string') {
    const parsed = parseJsonString(value)
    return parsed === null ? [] : collectExplicitTriggerWords(parsed, depth + 1)
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => collectExplicitTriggerWords(item, depth + 1))
  }

  if (!isRecord(value)) {
    return []
  }

  const directMatches = Object.entries(value).flatMap(([key, item]) =>
    isTriggerWordMetadataKey(key) ? collectStringsFromTriggerValue(item, depth + 1) : []
  )
  const nestedMatches = Object.values(value).flatMap((item) =>
    collectExplicitTriggerWords(item, depth + 1)
  )

  return [...directMatches, ...nestedMatches]
}

const isFallbackTriggerWordMetadataKey = (key: string): boolean => {
  const normalizedKey = normalizeMetadataKey(key)
  return ['ssoutputname', 'modelspectitle'].includes(normalizedKey)
}

const collectFallbackTriggerWords = (value: unknown, depth = 0): string[] => {
  if (depth > MAX_TRIGGER_WORD_SEARCH_DEPTH) {
    return []
  }

  if (typeof value === 'string') {
    const parsed = parseJsonString(value)
    return parsed === null ? [] : collectFallbackTriggerWords(parsed, depth + 1)
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => collectFallbackTriggerWords(item, depth + 1))
  }

  if (!isRecord(value)) {
    return []
  }

  const directMatches = Object.entries(value).flatMap(([key, item]) =>
    isFallbackTriggerWordMetadataKey(key) ? collectStringsFromTriggerValue(item, depth + 1) : []
  )
  const nestedMatches = Object.values(value).flatMap((item) =>
    collectFallbackTriggerWords(item, depth + 1)
  )

  return [...directMatches, ...nestedMatches]
}

const stripKnownModelExtension = (value: string): string => {
  const lowerValue = value.toLocaleLowerCase()
  const extension = LORA_MODEL_FILE_EXTENSIONS.find((item) => lowerValue.endsWith(item))
  return extension ? value.slice(0, -extension.length) : value
}

const cleanFallbackTriggerWord = (value: string): string => {
  const cleanedValue = cleanTriggerWord(value)
  const filename =
    cleanedValue
      .split(/[\\/]+/)
      .filter(Boolean)
      .pop() || cleanedValue
  return stripKnownModelExtension(filename).trim()
}

const normalizeFallbackTriggerWordCandidates = (candidates: string[]): string =>
  normalizeTriggerWordCandidates(candidates.map(cleanFallbackTriggerWord))

export const getFallbackTriggerWordsFromLoraName = (loraName: string): string =>
  normalizeFallbackTriggerWordCandidates([loraName])

export const extractTriggerWordsFromMetadataObject = (metadataObject: unknown): string =>
  normalizeTriggerWordCandidates(collectExplicitTriggerWords(metadataObject))

export const extractFallbackTriggerWordsFromMetadataObject = (metadataObject: unknown): string =>
  normalizeFallbackTriggerWordCandidates(collectFallbackTriggerWords(metadataObject))

export const extractTriggerWordsFromSafetensorsMetadata = (headerObject: unknown): string =>
  extractTriggerWordsFromMetadataObject(headerObject)

const readMetadataSidecarTriggerWords = (content: string): string => {
  const parsedContent = parseJsonString(content)
  return parsedContent === null ? '' : extractTriggerWordsFromMetadataObject(parsedContent)
}

const readSidecarTriggerWords = (content: string, kind: LoraTriggerWordsSidecarKind): string =>
  kind === 'text' ? normalizeTriggerWords(content) : readMetadataSidecarTriggerWords(content)

const filterExistingSidecarFiles = async (
  fileRefs: LoraTriggerWordsSidecarFileRef[]
): Promise<LoraTriggerWordsSidecarFileRef[]> => {
  const fileExistsBatch = api().svcShell?.fileExistsBatch
  if (typeof fileExistsBatch !== 'function' || fileRefs.length === 0) {
    return fileRefs
  }

  try {
    const exists = await fileExistsBatch(fileRefs.map((fileRef) => fileRef.fullPath))
    return fileRefs.filter((_, index) => exists[index])
  } catch {
    return fileRefs
  }
}

export const readLoraTriggerWordsSidecar = async (
  loraName: string,
  configUtils: ConfigUtils
): Promise<string> => {
  const fileRefs = await filterExistingSidecarFiles(
    resolveLoraTriggerWordsSidecarFiles(configUtils.getLoraDir(), loraName)
  )
  for (const fileRef of fileRefs) {
    try {
      const response = await api().svcFs.readTextFile({ fullPath: fileRef.fullPath })
      const triggerWords = readSidecarTriggerWords(response.content, fileRef.kind)
      if (triggerWords) {
        return triggerWords
      }
    } catch {
      // Try the next supported sidecar naming convention.
    }
  }

  return ''
}

export const resolveLoraComfyUIMetadataFilenames = (loraName: string): string[] => {
  const normalizedName = normalizeSelectedLoraName(loraName)
  if (!normalizedName) {
    return []
  }

  const extension = getPortablePathExtension(normalizedName)
  if (extension === SAFETENSORS_EXTENSION) {
    return [normalizedName]
  }
  if (LORA_MODEL_FILE_EXTENSIONS.includes(extension)) {
    return []
  }

  return [`${normalizedName}${SAFETENSORS_EXTENSION}`]
}

const readLoraTriggerWordsComfyUIMetadataValue = async (
  loraName: string,
  configUtils: ConfigUtils,
  extractor: (metadata: unknown) => string
): Promise<string> => {
  const comfyOrigin = configUtils.getComfyUIOrigin().trim()
  const metadataFilenames = resolveLoraComfyUIMetadataFilenames(loraName)
  if (!comfyOrigin || metadataFilenames.length === 0) {
    return ''
  }

  for (const metadataFilename of metadataFilenames) {
    try {
      const metadataUrl = new URL(
        `/view_metadata/${encodeURIComponent(COMFYUI_LORA_MODEL_FOLDER)}`,
        comfyOrigin
      )
      metadataUrl.searchParams.set('filename', metadataFilename)

      const response = await fetch(metadataUrl.href)
      if (!response.ok) {
        continue
      }

      const triggerWords = extractor({
        __metadata__: (await response.json()) as Record<string, unknown>
      })
      if (triggerWords) {
        return triggerWords
      }
    } catch {
      // Try the next supported metadata filename candidate.
    }
  }

  return ''
}

export const readLoraTriggerWordsComfyUIMetadata = async (
  loraName: string,
  configUtils: ConfigUtils
): Promise<string> =>
  readLoraTriggerWordsComfyUIMetadataValue(
    loraName,
    configUtils,
    extractTriggerWordsFromSafetensorsMetadata
  )

const readLoraFallbackTriggerWordsComfyUIMetadata = async (
  loraName: string,
  configUtils: ConfigUtils
): Promise<string> =>
  readLoraTriggerWordsComfyUIMetadataValue(
    loraName,
    configUtils,
    extractFallbackTriggerWordsFromMetadataObject
  )

export const readLoraTriggerWordsAuto = async (
  loraName: string,
  configUtils: ConfigUtils
): Promise<string> => {
  const triggerWordsFromMetadata = await readLoraTriggerWordsComfyUIMetadata(loraName, configUtils)
  if (triggerWordsFromMetadata) {
    return triggerWordsFromMetadata
  }

  const triggerWordsFromSidecar = await readLoraTriggerWordsSidecar(loraName, configUtils)
  if (triggerWordsFromSidecar) {
    return triggerWordsFromSidecar
  }

  const triggerWordsFromFallbackMetadata = await readLoraFallbackTriggerWordsComfyUIMetadata(
    loraName,
    configUtils
  )
  if (triggerWordsFromFallbackMetadata) {
    return triggerWordsFromFallbackMetadata
  }

  return getFallbackTriggerWordsFromLoraName(loraName)
}
