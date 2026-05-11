export const LORA_TRIGGER_WORDS_STORAGE_KEY = 'qapp.loraTriggerWords'

export type LoraTriggerWordsMap = Record<string, string>

const safeStorage = (): Storage | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

const normalizeLoraName = (loraName: string): string => loraName.trim()

export const normalizeTriggerWords = (triggerWords: string): string =>
  triggerWords
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(', ')

export const readLoraTriggerWordsMap = (): LoraTriggerWordsMap => {
  const storage = safeStorage()
  if (!storage) {
    return {}
  }

  try {
    const raw = storage.getItem(LORA_TRIGGER_WORDS_STORAGE_KEY)
    if (!raw) {
      return {}
    }
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {}
    }

    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>)
        .map(([name, triggerWords]) => [
          normalizeLoraName(name),
          normalizeTriggerWords(String(triggerWords || ''))
        ])
        .filter(([name, triggerWords]) => name && triggerWords)
    )
  } catch {
    return {}
  }
}

export const writeLoraTriggerWordsMap = (triggerWordsByLoraName: LoraTriggerWordsMap): void => {
  const storage = safeStorage()
  if (!storage) {
    return
  }

  const normalizedMap = Object.fromEntries(
    Object.entries(triggerWordsByLoraName)
      .map(([name, triggerWords]) => [normalizeLoraName(name), normalizeTriggerWords(triggerWords)])
      .filter(([name, triggerWords]) => name && triggerWords)
  )

  try {
    storage.setItem(LORA_TRIGGER_WORDS_STORAGE_KEY, JSON.stringify(normalizedMap))
  } catch {
    // Ignore storage quota or unavailable-storage failures.
  }
}

export const updateLoraTriggerWordsMap = (
  triggerWordsByLoraName: LoraTriggerWordsMap,
  loraName: string,
  triggerWords: string
): LoraTriggerWordsMap => {
  const normalizedName = normalizeLoraName(loraName)
  if (!normalizedName) {
    return triggerWordsByLoraName
  }

  const normalizedTriggerWords = normalizeTriggerWords(triggerWords)
  const next = { ...triggerWordsByLoraName }
  if (normalizedTriggerWords) {
    next[normalizedName] = normalizedTriggerWords
  } else {
    delete next[normalizedName]
  }
  return next
}

const splitPromptTags = (value: string): string[] =>
  value
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean)

export const appendPromptTriggerWords = (prompt: string, triggerWords: string): string => {
  const normalizedTriggerWords = normalizeTriggerWords(triggerWords)
  if (!normalizedTriggerWords) {
    return prompt
  }

  const promptTags = splitPromptTags(prompt)
  const existingTags = new Set(promptTags.map((tag) => tag.toLocaleLowerCase()))
  const missingTriggerTags = splitPromptTags(normalizedTriggerWords).filter(
    (tag) => !existingTags.has(tag.toLocaleLowerCase())
  )

  if (missingTriggerTags.length === 0) {
    return prompt
  }

  return [...promptTags, ...missingTriggerTags].join(', ')
}
