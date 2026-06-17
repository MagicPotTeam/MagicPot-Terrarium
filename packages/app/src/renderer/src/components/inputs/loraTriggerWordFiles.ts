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

const LORA_MODEL_FILE_EXTENSIONS = ['.safetensors', '.ckpt', '.pt', '.pth', '.bin']
const SAFETENSORS_EXTENSION = '.safetensors'
const MAX_TRIGGER_WORD_SEARCH_DEPTH = 6
const COMFYUI_LORA_MODEL_FOLDER = 'loras'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const hasParentTraversal = (relativePath: string): boolean =>
  relativePath.split(/[\\/]+/).some((segment) => segment === '..')

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

export const resolveLoraTriggerWordsFile = (
  loraDir: string,
  loraName: string,
  pathApi: BuiltInPath = window.path
): LoraTriggerWordsFileRef | null => {
  const modelFileRef = resolveLoraModelFile(loraDir, loraName, pathApi)
  if (!modelFileRef) {
    return null
  }

  const parsedName = pathApi.parse(modelFileRef.filename)
  const filename = `${parsedName.name}.txt`
  return {
    outputPath: modelFileRef.outputPath,
    filename,
    fullPath: pathApi.join(modelFileRef.outputPath, filename)
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

export const extractTriggerWordsFromMetadataObject = (metadataObject: unknown): string =>
  normalizeTriggerWordCandidates(collectExplicitTriggerWords(metadataObject))

export const extractTriggerWordsFromSafetensorsMetadata = (headerObject: unknown): string =>
  extractTriggerWordsFromMetadataObject(headerObject)

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

export const readLoraTriggerWordsComfyUIMetadata = async (
  loraName: string,
  configUtils: ConfigUtils
): Promise<string> => {
  const comfyOrigin = configUtils.getComfyUIOrigin().trim()
  if (!comfyOrigin || !loraName.toLocaleLowerCase().endsWith(SAFETENSORS_EXTENSION)) {
    return ''
  }

  try {
    const metadataUrl = new URL(
      `/view_metadata/${encodeURIComponent(COMFYUI_LORA_MODEL_FOLDER)}`,
      comfyOrigin
    )
    metadataUrl.searchParams.set('filename', loraName)

    const response = await fetch(metadataUrl.href)
    if (!response.ok) {
      return ''
    }

    return extractTriggerWordsFromSafetensorsMetadata({
      __metadata__: (await response.json()) as Record<string, unknown>
    })
  } catch {
    return ''
  }
}

export const readLoraTriggerWordsAuto = async (
  loraName: string,
  configUtils: ConfigUtils
): Promise<string> => {
  const triggerWordsFromMetadata = await readLoraTriggerWordsComfyUIMetadata(loraName, configUtils)
  if (triggerWordsFromMetadata) {
    return triggerWordsFromMetadata
  }

  return readLoraTriggerWordsSidecar(loraName, configUtils)
}
