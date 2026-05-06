import type { ChatAttachment } from '../QuickAppPage/QAppExecutePanel/qAppExecuteInputs/api/LLM'
import { buildReplyDownloadBaseNameFromAttachment } from './chatReplyDownloadUtils'

const BATCH_RESULT_MARKER_PREFIX = '<<<MAGICPOT_RESULT_'
const BATCH_RESULT_MARKER_SUFFIX = '>>>'
const BATCH_RESULT_END_MARKER_PREFIX = '<<<END_MAGICPOT_RESULT_'

export type AttachmentBatchEntry = {
  attachment: ChatAttachment
  preferredDownloadBaseName: string
  sequence: number
}

const isBatchEligibleAttachment = (attachment: ChatAttachment): boolean =>
  !attachment.reportBundleId && !attachment.reportBundleRole

export const getBatchEligibleAttachments = (
  attachments: ChatAttachment[] | undefined
): ChatAttachment[] => (attachments || []).filter(isBatchEligibleAttachment)

export const shouldBatchAttachments = (
  attachments: ChatAttachment[] | undefined
): attachments is ChatAttachment[] => {
  const normalizedAttachments = attachments || []
  return (
    normalizedAttachments.length > 1 &&
    normalizedAttachments.length === getBatchEligibleAttachments(normalizedAttachments).length
  )
}

export const buildAttachmentBatchEntries = (
  attachments: ChatAttachment[]
): AttachmentBatchEntry[] =>
  attachments.map((attachment, index) => ({
    attachment,
    preferredDownloadBaseName: buildReplyDownloadBaseNameFromAttachment(attachment),
    sequence: index + 1
  }))

export const chunkAttachmentBatchEntries = (
  entries: AttachmentBatchEntry[],
  maxBatchSize: number
): AttachmentBatchEntry[][] => {
  const normalizedBatchSize = Math.max(1, Math.floor(maxBatchSize) || 1)
  const chunks: AttachmentBatchEntry[][] = []

  for (let index = 0; index < entries.length; index += normalizedBatchSize) {
    chunks.push(entries.slice(index, index + normalizedBatchSize))
  }

  return chunks
}

const buildBatchMarker = (sequence: number): string =>
  `${BATCH_RESULT_MARKER_PREFIX}${sequence}${BATCH_RESULT_MARKER_SUFFIX}`

const buildBatchEndMarker = (sequence: number): string =>
  `${BATCH_RESULT_END_MARKER_PREFIX}${sequence}${BATCH_RESULT_MARKER_SUFFIX}`

const describeAttachment = (attachment: ChatAttachment, sequence: number): string => {
  const fileName =
    attachment.relativePath?.trim() || attachment.fileName?.trim() || `attachment-${sequence}`
  const dimensions =
    attachment.sourceWidth && attachment.sourceHeight
      ? `, ${attachment.sourceWidth}x${attachment.sourceHeight}`
      : ''
  const sizeBytes =
    typeof attachment.sizeBytes === 'number' ? `, ${attachment.sizeBytes} bytes` : ''
  return `${sequence}. ${fileName} [${attachment.type}${dimensions}${sizeBytes}]`
}

export const buildAttachmentBatchPrompt = (
  userContent: string,
  entries: AttachmentBatchEntry[]
): string => {
  const instructions = [
    'You are receiving multiple attachments in one request.',
    'Analyze each attachment independently and keep the original attachment order.',
    `Return exactly ${entries.length} sections using the exact markers below.`,
    'Do not add any text before the first marker or after the final end marker.',
    'Each section must contain only the final answer for its matching attachment.',
    'Attachment order:',
    ...entries.map((entry, index) => describeAttachment(entry.attachment, index + 1)),
    'Output format:',
    ...entries.flatMap((_, index) => [
      buildBatchMarker(index + 1),
      `(final answer for attachment ${index + 1})`,
      buildBatchEndMarker(index + 1)
    ])
  ]

  const trimmedUserContent = userContent.trim()
  if (!trimmedUserContent) {
    return instructions.join('\n')
  }

  return [`User request:`, trimmedUserContent, '', ...instructions].join('\n')
}

export const parseAttachmentBatchResponse = (
  responseContent: string,
  expectedCount: number
): string[] | null => {
  const results: string[] = []

  for (let index = 1; index <= expectedCount; index += 1) {
    const startMarker = buildBatchMarker(index)
    const endMarker = buildBatchEndMarker(index)
    const startIndex = responseContent.indexOf(startMarker)
    const endIndex = responseContent.indexOf(endMarker)

    if (startIndex < 0 || endIndex < 0 || endIndex <= startIndex) {
      return null
    }

    const sectionContent = responseContent.slice(startIndex + startMarker.length, endIndex).trim()

    results.push(sectionContent)
  }

  return results.length === expectedCount ? results : null
}
