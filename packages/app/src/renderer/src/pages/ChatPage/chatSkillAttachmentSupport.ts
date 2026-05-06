import type { LLMAPIProfile } from '@shared/config/config'
import { resolveProfileModelUse } from '@shared/llm'
import type { ChatAttachment } from '../QuickAppPage/QAppExecutePanel/qAppExecuteInputs/api/LLM'

type AttachmentCapabilityProfile = Pick<
  LLMAPIProfile,
  'model_use' | 'is_vision_model' | 'is_ocr_model'
>

export type SkillAttachmentSupport = {
  supportsImages: boolean
  supportsDocuments: boolean
}

export type SkillAttachmentSupportInspection = SkillAttachmentSupport & {
  hasImages: boolean
  hasDocuments: boolean
  unsupportedImages: boolean
  unsupportedDocuments: boolean
}

export const resolveSkillAttachmentSupport = (
  profile?: AttachmentCapabilityProfile | null
): SkillAttachmentSupport => {
  if (!profile) {
    return {
      supportsImages: false,
      supportsDocuments: false
    }
  }

  const modelUse = resolveProfileModelUse(profile)
  const supportsDocuments = modelUse === 'ocr' || Boolean(profile.is_ocr_model)
  const supportsImages =
    supportsDocuments ||
    modelUse === 'vision' ||
    modelUse === 'multimodal' ||
    Boolean(profile.is_vision_model)

  return {
    supportsImages,
    supportsDocuments
  }
}

export const inspectSkillAttachmentSupport = (
  attachments: ChatAttachment[] | undefined,
  profile?: AttachmentCapabilityProfile | null
): SkillAttachmentSupportInspection | null => {
  const hasImages = Boolean(attachments?.some((attachment) => attachment.type === 'image'))
  const hasDocuments = Boolean(attachments?.some((attachment) => attachment.type === 'file'))

  if (!hasImages && !hasDocuments) {
    return null
  }

  const support = resolveSkillAttachmentSupport(profile)

  return {
    ...support,
    hasImages,
    hasDocuments,
    unsupportedImages: hasImages && !support.supportsImages,
    unsupportedDocuments: hasDocuments && !support.supportsDocuments
  }
}
