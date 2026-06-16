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

const stripBalancedPromptWrappers = (tag: string): string => {
  let value = tag.trim()
  let changed = true

  while (changed && value.length >= 2) {
    changed = false
    const pairs: Array<[string, string]> = [
      ['(', ')'],
      ['[', ']'],
      ['{', '}']
    ]
    for (const [open, close] of pairs) {
      if (value.startsWith(open) && value.endsWith(close)) {
        value = value.slice(1, -1).trim()
        changed = true
        break
      }
    }
  }

  return value
}

const explicitWeightSuffixPattern = /\s*:\s*[+-]?(?:\d+(?:\.\d*)?|\.\d+)\s*$/

const promptTagIdentity = (tag: string): string =>
  stripBalancedPromptWrappers(tag)
    .replace(explicitWeightSuffixPattern, '')
    .trim()
    .toLocaleLowerCase()

const hasExplicitPromptWeight = (tag: string): boolean => {
  const value = tag.trim()
  const wrappedAsWeight =
    (value.startsWith('(') && value.endsWith(')')) ||
    (value.startsWith('[') && value.endsWith(']')) ||
    (value.startsWith('{') && value.endsWith('}'))
  return wrappedAsWeight || explicitWeightSuffixPattern.test(stripBalancedPromptWrappers(value))
}

export const appendPromptTriggerWords = (prompt: string, triggerWords: string): string => {
  const normalizedTriggerWords = normalizeTriggerWords(triggerWords)
  if (!normalizedTriggerWords) {
    return prompt
  }

  const triggerEntries = splitPromptTags(normalizedTriggerWords)
    .map((tag) => ({ tag, identity: promptTagIdentity(tag) }))
    .filter(({ identity }) => identity)
  if (triggerEntries.length === 0) {
    return prompt
  }

  const dedupedTriggerEntries = triggerEntries.filter(
    ({ identity }, index) =>
      triggerEntries.findIndex((item) => item.identity === identity) === index
  )
  const triggerIdentities = new Set(dedupedTriggerEntries.map(({ identity }) => identity))
  const promptTags = splitPromptTags(prompt)
  const existingTriggerTags = new Map<string, string>()
  const nonTriggerTags: string[] = []

  for (const tag of promptTags) {
    const identity = promptTagIdentity(tag)
    if (triggerIdentities.has(identity)) {
      const current = existingTriggerTags.get(identity)
      if (!current || (!hasExplicitPromptWeight(current) && hasExplicitPromptWeight(tag))) {
        existingTriggerTags.set(identity, tag)
      }
      continue
    }

    nonTriggerTags.push(tag)
  }

  const leadingTriggerTags = dedupedTriggerEntries.map(({ tag, identity }) => {
    const existingTag = existingTriggerTags.get(identity)
    if (!existingTag) {
      return tag
    }
    if (hasExplicitPromptWeight(existingTag)) {
      return existingTag
    }
    if (hasExplicitPromptWeight(tag)) {
      return tag
    }
    return existingTag
  })

  return [...leadingTriggerTags, ...nonTriggerTags].join(', ')
}
