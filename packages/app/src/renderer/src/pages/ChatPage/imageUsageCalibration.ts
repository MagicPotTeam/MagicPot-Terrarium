import type { ChatCapabilityProfile } from '@shared/llm'
import type { ChatMessage } from '../QuickAppPage/QAppExecutePanel/qAppExecuteInputs/api/LLM'
import { estimateTextTokenCount } from './chatContextCompression'

export type ChatContextTokenCalibration = {
  textRatios: number[]
  imageRatios: number[]
  aggregateRatios?: number[]
}

export const buildChatContextTokenCalibrationFingerprint = (scope: {
  profileId?: string | null
  profile?: ChatCapabilityProfile | null
  imageHistoryPolicy?: 'latest-user-turn' | 'all'
}): string =>
  JSON.stringify({
    profileId: String(scope.profileId || '').trim(),
    provider: String(scope.profile?.provider || '').trim(),
    deployment: String(scope.profile?.deployment || '').trim(),
    callType: String(scope.profile?.call_type || '').trim(),
    baseUrl: String(scope.profile?.base_url || '').trim(),
    model: String(scope.profile?.model_name || '').trim(),
    attachmentTransports: [
      ...((scope.profile as { attachment_transports?: string[] } | null | undefined)
        ?.attachment_transports || [])
    ]
      .map(String)
      .sort(),
    preferredAttachmentTransport: String(
      (scope.profile as { preferred_attachment_transport?: string } | null | undefined)
        ?.preferred_attachment_transport || ''
    ).trim(),
    imageHistoryPolicy: scope.imageHistoryPolicy || 'latest-user-turn'
  })

export const resetChatContextTokenCalibration = (
  items: Map<string, ChatContextTokenCalibration>,
  fingerprint?: string
): void => {
  if (fingerprint) items.delete(fingerprint)
  else items.clear()
}
const boundedRatio = (actual: number, estimated: number): number | null =>
  Number.isFinite(actual) && actual >= 0 && Number.isFinite(estimated) && estimated > 0
    ? Math.min(2, Math.max(1, actual / estimated))
    : null
export const recordChatContextTokenObservation = (
  calibration: ChatContextTokenCalibration | undefined,
  observation: {
    estimatedTextTokens: number
    estimatedImageTokens: number
    actualInputTextTokens?: number
    actualInputImageTokens?: number
    actualInputTokens?: number
  }
): ChatContextTokenCalibration => {
  const next: ChatContextTokenCalibration = {
    textRatios: [...(calibration?.textRatios || [])],
    imageRatios: [...(calibration?.imageRatios || [])],
    ...(calibration?.aggregateRatios ? { aggregateRatios: [...calibration.aggregateRatios] } : {})
  }
  const text =
    observation.actualInputTextTokens === undefined
      ? null
      : boundedRatio(observation.actualInputTextTokens, observation.estimatedTextTokens)
  const image =
    observation.actualInputImageTokens === undefined
      ? null
      : boundedRatio(observation.actualInputImageTokens, observation.estimatedImageTokens)
  if (text !== null) next.textRatios.push(text)
  if (image !== null) next.imageRatios.push(image)
  if (text === null && image === null && observation.actualInputTokens !== undefined) {
    const aggregate = boundedRatio(
      observation.actualInputTokens,
      observation.estimatedTextTokens + observation.estimatedImageTokens
    )
    if (aggregate !== null) next.aggregateRatios = [...(next.aggregateRatios || []), aggregate]
  }
  next.textRatios = next.textRatios.slice(-8)
  next.imageRatios = next.imageRatios.slice(-8)
  if (next.aggregateRatios) next.aggregateRatios = next.aggregateRatios.slice(-8)
  return next
}
const multiplier = (values?: readonly number[]): number =>
  values?.length ? Math.max(...values) : 1
export const estimateChatMessageImageTokenCount = (message: ChatMessage): number =>
  (message.attachments || []).reduce((total, attachment) => {
    if (attachment.type !== 'image') return total
    const width = attachment.sourceWidth || attachment.media?.width
    const height = attachment.sourceHeight || attachment.media?.height
    if (width && height) return total + 85 + Math.ceil(width / 512) * Math.ceil(height / 512) * 170
    const bytes = attachment.sizeBytes || attachment.media?.sizeBytes
    return total + (bytes ? Math.max(85, Math.ceil(bytes / 1024) * 8) : 1024)
  }, 0)
export const estimateChatMessagesTokenBreakdown = (
  messages: readonly ChatMessage[],
  calibration?: ChatContextTokenCalibration
) => {
  const rawImage = messages.reduce(
    (sum, message) => sum + estimateChatMessageImageTokenCount(message),
    0
  )
  const rawText = messages.reduce(
    (sum, message) =>
      sum +
      10 +
      estimateTextTokenCount(message.content) +
      estimateTextTokenCount(message.hiddenContext) +
      (message.attachments || [])
        .filter((a) => a.type !== 'image')
        .reduce(
          (n, a) =>
            n +
            estimateTextTokenCount(
              [a.type, a.fileName, a.mimeType, a.ocrResult?.text].filter(Boolean).join(' ')
            ),
          0
        ),
    0
  )
  const textTokens = Math.ceil(rawText * multiplier(calibration?.textRatios))
  const imageTokens = Math.ceil(rawImage * multiplier(calibration?.imageRatios))
  return {
    textTokens,
    imageTokens,
    totalTokens: Math.max(
      textTokens + imageTokens,
      Math.ceil((rawText + rawImage) * multiplier(calibration?.aggregateRatios))
    )
  }
}
