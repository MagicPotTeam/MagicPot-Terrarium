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

export type SelectedLoraTriggerWords = {
  loraName: string
  triggerWords: string
}

const LORA_MODEL_FILE_EXTENSIONS = ['.safetensors', '.ckpt', '.pt', '.pth', '.bin']

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const hasParentTraversal = (relativePath: string): boolean =>
  relativePath.split(/[\\/]+/).some((segment, index) => index === 0 && segment === '..')

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

export const resolveLoraTriggerWordsFile = (
  loraDir: string,
  loraName: string,
  pathApi: BuiltInPath = window.path
): LoraTriggerWordsFileRef | null => {
  const baseDir = pathApi.normalize(loraDir.trim())
  const normalizedName = loraName.trim()

  if (!baseDir || !normalizedName || pathApi.isAbsolute(normalizedName)) {
    return null
  }

  const nameSegments = normalizedName.split(/[\\/]+/).filter(Boolean)
  if (nameSegments.some((segment) => segment === '..')) {
    return null
  }

  const modelPath = pathApi.normalize(pathApi.join(baseDir, ...nameSegments))
  const relativePath = pathApi.relative(baseDir, modelPath)
  if (pathApi.isAbsolute(relativePath) || hasParentTraversal(relativePath)) {
    return null
  }

  const parsed = pathApi.parse(modelPath)
  const filename = `${parsed.name || pathApi.basename(modelPath, parsed.ext)}.txt`
  const outputPath = parsed.dir || baseDir

  return {
    outputPath,
    filename,
    fullPath: pathApi.join(outputPath, filename)
  }
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
