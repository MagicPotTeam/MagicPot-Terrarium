import type {
  ChatAttachment,
  ChatMessage
} from '../QuickAppPage/QAppExecutePanel/qAppExecuteInputs/api/LLM'
import { buildNormalizedTaggingSidecarText, parseNormalizedTaggingResponse } from '@shared/llm'
import { BUILT_IN_TAGGING_SKILL_ID } from './builtInSkills'
import { getDownloadFileNameFromUrl } from './chatPageShared'
import { getVisibleChatAttachments } from './chatAttachmentVisibility'

const INVALID_FILE_PART_CHARACTERS = '<>:"/\\|?*'
const DEFAULT_REPLY_DOWNLOAD_BASE_NAME = 'assistant-reply'
const MEDIA_ATTACHMENT_TYPES = new Set<ChatAttachment['type']>([
  'image',
  'video',
  'model3d',
  'file'
])
const CJK_CHAR_REGEX = /[\u3400-\u9fff\uf900-\ufaff]/
const MAX_FILE_NAME_UNITS = 20
const GENERATED_VIDEO_REGEX = /\[Generated Video\]\(([^)]+)\)/g
const PROMPT_YAML_FENCE_REGEX = /```ya?ml\s*\n([\s\S]*?)```/gi
const POSITIVE_PROMPT_LABEL_REGEX = /(正面提示词|positive prompt)/i
const NEGATIVE_PROMPT_LABEL_REGEX = /(负面提示词|negative prompt)/i
const PROMPT_FIELD_HEADER_REGEX =
  /^\s*['"]?([^:'"]*(?:正面提示词|负面提示词|positive prompt|negative prompt)[^:'"]*)['"]?\s*:\s*(.*)$/i
const YAML_MAPPING_HEADER_REGEX = /^\s{0,2}[^:\n]+:\s*(?:[>|][+-]?)?\s*$/

type PromptYamlFieldKind = 'positive' | 'negative'

interface PromptYamlField {
  label: string
  lines: string[]
}

const sanitizeFilePart = (value: string): string => {
  let cleaned = ''
  let lastWasReplacement = false

  for (const char of value.trim()) {
    const isInvalid = char.charCodeAt(0) <= 0x1f || INVALID_FILE_PART_CHARACTERS.includes(char)

    if (isInvalid) {
      if (!lastWasReplacement) {
        cleaned += '_'
        lastWasReplacement = true
      }
      continue
    }

    cleaned += char
    lastWasReplacement = false
  }

  return cleaned || DEFAULT_REPLY_DOWNLOAD_BASE_NAME
}

const stripFileExtension = (fileName: string): string => fileName.replace(/\.[^.]+$/, '')

const inferPromptYamlFieldKind = (label: string): PromptYamlFieldKind | null => {
  if (NEGATIVE_PROMPT_LABEL_REGEX.test(label)) {
    return 'negative'
  }

  if (POSITIVE_PROMPT_LABEL_REGEX.test(label)) {
    return 'positive'
  }

  return null
}

const normalizePromptYamlInlineValue = (value: string): string => {
  const trimmed = value.trim()
  if (!trimmed || /^[>|][+-]?$/.test(trimmed)) {
    return ''
  }

  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim()
  }

  return trimmed
}

const parsePromptYamlFieldHeader = (
  line: string
): { label: string; inlineValue: string } | null => {
  const match = line.match(PROMPT_FIELD_HEADER_REGEX)
  if (!match) {
    return null
  }

  const label = match[1]?.trim()
  const kind = label ? inferPromptYamlFieldKind(label) : null
  if (!label || !kind) {
    return null
  }

  return {
    label,
    inlineValue: normalizePromptYamlInlineValue(match[2] || '')
  }
}

const normalizePromptYamlValue = (lines: string[]): string =>
  lines
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()

const normalizePromptYamlBody = (body: string): string | null => {
  const fields: PromptYamlField[] = []
  let currentField: PromptYamlField | null = null

  const flushCurrentField = () => {
    if (!currentField) {
      return
    }

    const value = normalizePromptYamlValue(currentField.lines)
    if (value) {
      fields.push({
        ...currentField,
        lines: [value]
      })
    }
    currentField = null
  }

  for (const line of body.split(/\r?\n/)) {
    const promptFieldHeader = parsePromptYamlFieldHeader(line)
    if (promptFieldHeader) {
      flushCurrentField()
      currentField = {
        label: promptFieldHeader.label,
        lines: promptFieldHeader.inlineValue ? [promptFieldHeader.inlineValue] : []
      }
      continue
    }

    if (!currentField) {
      continue
    }

    if (YAML_MAPPING_HEADER_REGEX.test(line)) {
      flushCurrentField()
      continue
    }

    currentField.lines.push(line)
  }

  flushCurrentField()

  if (!fields.length) {
    return null
  }

  return fields.map((field) => `${field.label}：\n${field.lines[0]}`).join('\n\n')
}

const normalizeAssistantPromptYamlBlocks = (content: string): string => {
  let replacedPromptYaml = false
  const normalized = content.replace(PROMPT_YAML_FENCE_REGEX, (match, body: string) => {
    const promptText = normalizePromptYamlBody(body)
    if (!promptText) {
      return match
    }

    replacedPromptYaml = true
    return promptText
  })

  if (!replacedPromptYaml) {
    return content
  }

  return normalized.replace(/\n{3,}/g, '\n\n').trim()
}

const getAttachmentFileName = (attachment: ChatAttachment): string | null => {
  const explicitFileName = attachment.fileName?.trim()
  if (explicitFileName) {
    return explicitFileName
  }

  if (!attachment.url?.trim()) {
    return null
  }

  const fallbackName = getDownloadFileNameFromUrl(attachment.url, '')
  return fallbackName.trim() || null
}

const getAttachmentBaseName = (attachment: ChatAttachment): string | null => {
  if (!MEDIA_ATTACHMENT_TYPES.has(attachment.type)) {
    return null
  }

  const fileName = getAttachmentFileName(attachment)
  if (fileName) {
    return stripFileExtension(fileName)
  }

  return null
}

const getPreferredAssistantBaseName = (message: ChatMessage | undefined): string | null => {
  const preferredBaseName = message?.preferredDownloadBaseName?.trim()
  if (!preferredBaseName) {
    return null
  }

  return sanitizeFilePart(stripFileExtension(preferredBaseName))
}

const truncateForFileName = (value: string): string => {
  const collapsed = value.replace(/\s+/g, ' ').trim()
  if (!collapsed) {
    return DEFAULT_REPLY_DOWNLOAD_BASE_NAME
  }

  let consumedUnits = 0
  let result = ''

  for (const char of collapsed) {
    const nextUnits = CJK_CHAR_REGEX.test(char) ? 2 : 1
    if (consumedUnits + nextUnits > MAX_FILE_NAME_UNITS) {
      break
    }
    result += char
    consumedUnits += nextUnits
  }

  return result.trim() || DEFAULT_REPLY_DOWNLOAD_BASE_NAME
}

export type AssistantReplyDownloadMode = 'reply' | 'sidecar'
export interface AssistantSidecarExportEntry {
  assistantMessageIndex: number
  baseName: string
  textContent: string
}

export const resolveAssistantReplyDownloadMode = (
  messages: ChatMessage[],
  assistantMessageIndex: number,
  sessionSkillId?: string | null
): AssistantReplyDownloadMode => {
  const assistantMessage = messages[assistantMessageIndex]

  if (assistantMessage?.preferredDownloadBaseName?.trim()) {
    return 'sidecar'
  }

  if (sessionSkillId === BUILT_IN_TAGGING_SKILL_ID) {
    return 'sidecar'
  }

  return 'reply'
}

export const extractAssistantReplyTextContent = (
  content: string | undefined,
  options?: {
    preferTaggingSidecar?: boolean
  }
): string => {
  const cleaned = (content || '').replace(GENERATED_VIDEO_REGEX, '').trim()
  if (!cleaned) {
    return ''
  }

  if (options?.preferTaggingSidecar) {
    const parsed = parseNormalizedTaggingResponse(cleaned)
    const firstResult = parsed?.results[0]
    if (firstResult) {
      return buildNormalizedTaggingSidecarText(firstResult)
    }
  }

  return normalizeAssistantPromptYamlBlocks(cleaned)
}

const ensureUniqueAssistantReplyBaseName = (
  baseName: string,
  seenBaseNames: Map<string, number>
) => {
  const count = seenBaseNames.get(baseName) ?? 0
  seenBaseNames.set(baseName, count + 1)
  if (count === 0) {
    return baseName
  }
  return `${baseName}_${count + 1}`
}

export const resolveAssistantSidecarExportEntries = (
  messages: ChatMessage[],
  sessionSkillId?: string | null
): AssistantSidecarExportEntry[] => {
  const entries: AssistantSidecarExportEntry[] = []
  const seenBaseNames = new Map<string, number>()

  for (
    let assistantMessageIndex = 0;
    assistantMessageIndex < messages.length;
    assistantMessageIndex += 1
  ) {
    const message = messages[assistantMessageIndex]
    if (message?.role !== 'assistant') {
      continue
    }

    if (
      resolveAssistantReplyDownloadMode(messages, assistantMessageIndex, sessionSkillId) !==
      'sidecar'
    ) {
      continue
    }

    const textContent = extractAssistantReplyTextContent(message.content, {
      preferTaggingSidecar: sessionSkillId === BUILT_IN_TAGGING_SKILL_ID
    })
    if (!textContent) {
      continue
    }

    const baseName = ensureUniqueAssistantReplyBaseName(
      buildAssistantReplyDownloadBaseName(messages, assistantMessageIndex),
      seenBaseNames
    )

    entries.push({
      assistantMessageIndex,
      baseName,
      textContent
    })
  }

  return entries
}

export const buildAssistantReplyDownloadBaseName = (
  messages: ChatMessage[],
  assistantMessageIndex: number
): string => {
  const preferredAssistantBaseName = getPreferredAssistantBaseName(messages[assistantMessageIndex])
  if (preferredAssistantBaseName) {
    return preferredAssistantBaseName
  }

  for (let index = assistantMessageIndex - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== 'user') {
      continue
    }

    const attachmentBaseName = getVisibleChatAttachments(message.attachments)
      ?.map((attachment) => getAttachmentBaseName(attachment))
      .find((value): value is string => Boolean(value?.trim()))

    if (attachmentBaseName) {
      return sanitizeFilePart(attachmentBaseName)
    }

    if (message.content?.trim()) {
      return sanitizeFilePart(truncateForFileName(message.content))
    }
  }

  return DEFAULT_REPLY_DOWNLOAD_BASE_NAME
}

export const buildReplyDownloadBaseNameFromAttachment = (attachment: ChatAttachment): string =>
  sanitizeFilePart(getAttachmentBaseName(attachment) || DEFAULT_REPLY_DOWNLOAD_BASE_NAME)

export const buildAssistantReplyDownloadFileName = (
  messages: ChatMessage[],
  assistantMessageIndex: number,
  extension: '.md' | '.txt'
): string => `${buildAssistantReplyDownloadBaseName(messages, assistantMessageIndex)}${extension}`
