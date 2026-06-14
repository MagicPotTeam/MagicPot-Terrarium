import type { ChatAttachment } from '@shared/api/svcLLMProxy'
import {
  type LLMReasoningEffort,
  type OpenAIImageGenerationOptions,
  normalizeOpenAIImageGenerationSize,
  normalizeReasoningEffort
} from '@shared/llm'

export const normalizeReasoningPreferenceMap = (
  value: Record<string, string | LLMReasoningEffort>
): Record<string, LLMReasoningEffort> =>
  Object.fromEntries(
    Object.entries(value)
      .map(([profileKey, effort]) => [profileKey, normalizeReasoningEffort(effort)] as const)
      .filter(
        (entry): entry is readonly [string, LLMReasoningEffort] =>
          Boolean(entry[0]?.trim()) && Boolean(entry[1])
      )
  )

export const readStoredReasoningEffortMap = (
  storageKey: string,
  storage: Pick<Storage, 'getItem'> = localStorage
): Record<string, LLMReasoningEffort> => {
  try {
    const raw = storage.getItem(storageKey)
    if (!raw) {
      return {}
    }

    const parsed = JSON.parse(raw) as Record<string, string>
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {}
    }

    return normalizeReasoningPreferenceMap(parsed)
  } catch {
    return {}
  }
}

export const readStoredImageGenerationOptions = (
  storageKey: string,
  defaultOptions: OpenAIImageGenerationOptions,
  storage: Pick<Storage, 'getItem'> = localStorage
): OpenAIImageGenerationOptions => {
  try {
    const raw = storage.getItem(storageKey)
    if (!raw) {
      return { ...defaultOptions }
    }

    const parsed = JSON.parse(raw) as OpenAIImageGenerationOptions
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ...defaultOptions }
    }

    return {
      ...defaultOptions,
      ...parsed
    }
  } catch {
    return { ...defaultOptions }
  }
}

export const resolveReferenceImageGenerationSizeFromAttachments = (
  attachments: ChatAttachment[] | undefined
): string | undefined => {
  const referenceImage = attachments?.find((attachment) => {
    if (attachment.type !== 'image') return false
    const width = Number(attachment.sourceWidth)
    const height = Number(attachment.sourceHeight)
    return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
  })

  if (!referenceImage) {
    return undefined
  }

  return normalizeOpenAIImageGenerationSize(
    `${Math.round(Number(referenceImage.sourceWidth))}x${Math.round(Number(referenceImage.sourceHeight))}`
  )
}

export const resolveImageGenerationOptionsForAttachments = (
  options: OpenAIImageGenerationOptions,
  attachments: ChatAttachment[] | undefined
): OpenAIImageGenerationOptions => {
  const requestedSize = normalizeOpenAIImageGenerationSize(options.size)
  if (requestedSize && requestedSize !== 'auto') {
    return {
      ...options,
      size: requestedSize
    }
  }

  const referenceSize = resolveReferenceImageGenerationSizeFromAttachments(attachments)
  if (!referenceSize) {
    return requestedSize
      ? {
          ...options,
          size: requestedSize
        }
      : options
  }

  return {
    ...options,
    size: referenceSize
  }
}
