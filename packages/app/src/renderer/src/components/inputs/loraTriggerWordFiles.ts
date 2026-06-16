import { api } from '@renderer/utils/windowUtils'
import type { ConfigUtils } from '@shared/config/configUtils'
import type { BuiltInPath } from '@shared/utils/utilWindow'
import {
  normalizeTriggerWords,
  readLoraTriggerWordsMap,
  type LoraTriggerWordsMap
} from './loraTriggerWords'

export type LoraTriggerWordsFileRef = {
  outputPath: string
  filename: string
  fullPath: string
}

export type LoraModelFileRef = {
  outputPath: string
  filename: string
  fullPath: string
}

export type SelectedLoraTriggerWords = {
  loraName: string
  triggerWords: string
}

const LORA_MODEL_FILE_EXTENSIONS = ['.safetensors', '.ckpt', '.pt', '.pth', '.bin']
const LORA_JSON_METADATA_SIDECAR_EXTENSIONS = ['.civitai.info', '.json']
const SAFETENSORS_EXTENSION = '.safetensors'
const SAFETENSORS_HEADER_PREFIX_BYTES = 8
const MAX_SAFETENSORS_HEADER_BYTES = 16 * 1024 * 1024
const MAX_TRIGGER_WORD_SEARCH_DEPTH = 6

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const hasParentTraversal = (relativePath: string): boolean =>
  relativePath.split(/[\\/]+/).some((segment) => segment === '..')

const normalizeCompanionExtension = (extension: string): string => {
  const normalizedExtension = extension.trim()
  return normalizedExtension.startsWith('.') ? normalizedExtension : `.${normalizedExtension}`
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

export const resolveLoraCompanionFile = (
  loraDir: string,
  loraName: string,
  companionExtension: string,
  pathApi: BuiltInPath = window.path
): LoraTriggerWordsFileRef | null => {
  const modelFileRef = resolveLoraModelFile(loraDir, loraName, pathApi)
  if (!modelFileRef) {
    return null
  }

  const parsed = pathApi.parse(modelFileRef.fullPath)
  const filename = `${parsed.name || pathApi.basename(modelFileRef.fullPath, parsed.ext)}${normalizeCompanionExtension(companionExtension)}`
  const outputPath = parsed.dir || modelFileRef.outputPath

  return {
    outputPath,
    filename,
    fullPath: pathApi.join(outputPath, filename)
  }
}

export const resolveLoraTriggerWordsFile = (
  loraDir: string,
  loraName: string,
  pathApi: BuiltInPath = window.path
): LoraTriggerWordsFileRef | null => resolveLoraCompanionFile(loraDir, loraName, '.txt', pathApi)

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

export const extractTriggerWordsFromMetadataObject = (metadataObject: unknown): string =>
  normalizeTriggerWordCandidates(collectExplicitTriggerWords(metadataObject))

const getSafetensorsMetadataRecord = (headerObject: unknown): Record<string, unknown> | null => {
  if (!isRecord(headerObject)) {
    return null
  }

  const embeddedMetadata = headerObject.__metadata__
  return isRecord(embeddedMetadata) ? embeddedMetadata : headerObject
}

const cleanDatasetDirCandidate = (candidate: string): string => {
  const withoutCountSuffix = candidate.split(':')[0]?.trim() || ''
  const pathSegments = withoutCountSuffix.split(/[\\/]+/).filter(Boolean)
  const lastSegment = pathSegments[pathSegments.length - 1] || withoutCountSuffix
  return cleanTriggerWord(lastSegment.replace(/^\d+[ _-]+/, '').trim())
}

const extractDatasetDirTriggerWords = (value: unknown): string[] => {
  const parsed = typeof value === 'string' ? parseJsonString(value) : null
  const datasetValue = parsed ?? value
  let candidates: string[] = []

  if (typeof datasetValue === 'string') {
    candidates = datasetValue.split(/[,\r\n]+/)
  } else if (Array.isArray(datasetValue)) {
    candidates = datasetValue.filter((item): item is string => typeof item === 'string')
  } else if (isRecord(datasetValue)) {
    candidates = Object.keys(datasetValue)
  }

  return candidates
    .map(cleanDatasetDirCandidate)
    .filter(
      (candidate) =>
        candidate &&
        candidate.length <= 80 &&
        !/^(dataset|datasets|image|images|img|imgs|train|training|reg|regularization)$/i.test(
          candidate
        )
    )
    .slice(0, 8)
}

export const extractTriggerWordsFromSafetensorsMetadata = (headerObject: unknown): string => {
  const explicitTriggerWords = extractTriggerWordsFromMetadataObject(headerObject)
  if (explicitTriggerWords) {
    return explicitTriggerWords
  }

  const metadata = getSafetensorsMetadataRecord(headerObject)
  if (!metadata) {
    return ''
  }

  return normalizeTriggerWordCandidates(
    extractDatasetDirTriggerWords(metadata.ss_dataset_dirs ?? metadata.ssDatasetDirs)
  )
}

const toUint8Array = (data: Uint8Array | ArrayLike<number>): Uint8Array =>
  data instanceof Uint8Array ? data : new Uint8Array(data)

export const readSafetensorsHeaderLength = (
  prefixBytes: Uint8Array | ArrayLike<number>
): number | null => {
  const bytes = toUint8Array(prefixBytes)
  if (bytes.length < SAFETENSORS_HEADER_PREFIX_BYTES) {
    return null
  }

  const low = bytes[0] + bytes[1] * 0x100 + bytes[2] * 0x10000 + bytes[3] * 0x1000000
  const high = bytes[4] + bytes[5] * 0x100 + bytes[6] * 0x10000 + bytes[7] * 0x1000000
  const maxSafeHigh = Math.floor((Number.MAX_SAFE_INTEGER - low) / 0x100000000)
  if (high > maxSafeHigh) {
    return null
  }

  const headerLength = high * 0x100000000 + low
  if (headerLength <= 0 || headerLength > MAX_SAFETENSORS_HEADER_BYTES) {
    return null
  }

  return headerLength
}

export const readLoraTriggerWordsSidecar = async (
  loraName: string,
  configUtils: ConfigUtils
): Promise<string> => {
  const fileRef = resolveLoraTriggerWordsFile(configUtils.getLoraDir(), loraName)
  if (!fileRef) {
    return ''
  }

  try {
    const response = await api().svcFs.readTextFile({ fullPath: fileRef.fullPath })
    return normalizeTriggerWords(response.content)
  } catch {
    return ''
  }
}

const readLoraTriggerWordsJsonSidecar = async (
  loraName: string,
  configUtils: ConfigUtils
): Promise<string> => {
  const loraDir = configUtils.getLoraDir()
  for (const extension of LORA_JSON_METADATA_SIDECAR_EXTENSIONS) {
    const fileRef = resolveLoraCompanionFile(loraDir, loraName, extension)
    if (!fileRef) {
      continue
    }

    try {
      const response = await api().svcFs.readTextFile({ fullPath: fileRef.fullPath })
      const triggerWords = extractTriggerWordsFromMetadataObject(response.content)
      if (triggerWords) {
        return triggerWords
      }
    } catch {
      // Try the next supported metadata sidecar.
    }
  }

  return ''
}

export const readLoraTriggerWordsSafetensorsMetadata = async (
  loraName: string,
  configUtils: ConfigUtils
): Promise<string> => {
  const modelFileRef = resolveLoraModelFile(configUtils.getLoraDir(), loraName)
  if (
    !modelFileRef ||
    window.path.extname(modelFileRef.fullPath).toLocaleLowerCase() !== SAFETENSORS_EXTENSION
  ) {
    return ''
  }

  try {
    const prefixResponse = await api().svcFs.readFileSlice({
      fullPath: modelFileRef.fullPath,
      offset: 0,
      length: SAFETENSORS_HEADER_PREFIX_BYTES
    })
    const headerLength = readSafetensorsHeaderLength(prefixResponse.data)
    if (!headerLength) {
      return ''
    }

    const headerResponse = await api().svcFs.readFileSlice({
      fullPath: modelFileRef.fullPath,
      offset: SAFETENSORS_HEADER_PREFIX_BYTES,
      length: headerLength
    })
    const headerBytes = toUint8Array(headerResponse.data)
    if (headerBytes.length < headerLength) {
      return ''
    }

    const headerText = new TextDecoder().decode(headerBytes)
    return extractTriggerWordsFromSafetensorsMetadata(JSON.parse(headerText))
  } catch {
    return ''
  }
}

export const readLoraTriggerWordsAuto = async (
  loraName: string,
  configUtils: ConfigUtils
): Promise<string> => {
  const readers = [
    readLoraTriggerWordsSidecar,
    readLoraTriggerWordsJsonSidecar,
    readLoraTriggerWordsSafetensorsMetadata
  ]

  for (const reader of readers) {
    const triggerWords = await reader(loraName, configUtils)
    if (triggerWords) {
      return triggerWords
    }
  }

  return ''
}

export const collectSelectedLoraTriggerWords = (
  formState: Map<string, unknown>,
  triggerWordsByLoraName: LoraTriggerWordsMap = readLoraTriggerWordsMap()
): SelectedLoraTriggerWords[] => {
  const selectedByName = new Map<string, string>()

  for (const value of formState.values()) {
    if (!Array.isArray(value)) {
      continue
    }

    for (const item of value) {
      if (!isRecord(item) || typeof item.lora_name !== 'string') {
        continue
      }

      const loraName = item.lora_name.trim()
      if (!loraName) {
        continue
      }

      const rowTriggerWords =
        typeof item.trigger_words === 'string'
          ? item.trigger_words
          : triggerWordsByLoraName[loraName]
      const triggerWords = normalizeTriggerWords(rowTriggerWords || '')
      if (triggerWords) {
        selectedByName.set(loraName, triggerWords)
      }
    }
  }

  return Array.from(selectedByName, ([loraName, triggerWords]) => ({ loraName, triggerWords }))
}

export const writeSelectedLoraTriggerWordFiles = async ({
  formState,
  configUtils
}: {
  formState: Map<string, unknown>
  configUtils: ConfigUtils
}): Promise<LoraTriggerWordsFileRef[]> => {
  const loraDir = configUtils.getLoraDir()
  const writtenFiles: LoraTriggerWordsFileRef[] = []

  for (const selected of collectSelectedLoraTriggerWords(formState)) {
    const fileRef = resolveLoraTriggerWordsFile(loraDir, selected.loraName)
    if (!fileRef) {
      continue
    }

    await api().svcFs.writeTextFile({
      outputPath: fileRef.outputPath,
      filename: fileRef.filename,
      content: selected.triggerWords
    })
    writtenFiles.push(fileRef)
  }

  return writtenFiles
}
