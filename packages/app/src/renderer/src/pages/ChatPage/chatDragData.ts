import type {
  ChatAttachment,
  ChatMessage
} from '../QuickAppPage/QAppExecutePanel/qAppExecuteInputs/api/LLM'
import { INTERNAL_IMAGE_DRAG_PREFIX, QAPP_IMAGE_DRAG_MIME } from '@renderer/utils/droppedImageUtils'
import { getDownloadFileNameFromUrl, normalizeLocalMediaUrl } from './chatPageShared'

export const AGENT_IMAGE_DRAG_MIME = 'application/x-ai-image'
export const AGENT_VIDEO_DRAG_MIME = 'application/x-ai-video'
export const AGENT_MODEL3D_DRAG_MIME = 'application/x-ai-model3d'

type DragDataTarget = Pick<DataTransfer, 'setData' | 'effectAllowed'>

const setAgentDragPayload = (
  dataTransfer: DragDataTarget,
  mimeType: string,
  url: string
): string => {
  const normalizedUrl = normalizeLocalMediaUrl(url)
  dataTransfer.setData(mimeType, normalizedUrl)
  dataTransfer.setData('text/uri-list', normalizedUrl)
  dataTransfer.setData('text/plain', normalizedUrl)
  dataTransfer.effectAllowed = 'copy'
  return normalizedUrl
}

export const setAgentImageDragPayload = (dataTransfer: DragDataTarget, url: string): string =>
  setAgentDragPayload(dataTransfer, AGENT_IMAGE_DRAG_MIME, url)

export const setAgentVideoDragPayload = (
  dataTransfer: DragDataTarget,
  url: string,
  fileName?: string
): string => {
  const normalizedUrl = normalizeLocalMediaUrl(url)
  dataTransfer.setData(
    AGENT_VIDEO_DRAG_MIME,
    JSON.stringify({
      url: normalizedUrl,
      fileName: fileName || getDownloadFileNameFromUrl(normalizedUrl, 'video.mp4')
    })
  )
  dataTransfer.setData('text/uri-list', normalizedUrl)
  dataTransfer.setData('text/plain', normalizedUrl)
  dataTransfer.effectAllowed = 'copy'
  return normalizedUrl
}

export const setAgentModel3DDragPayload = (dataTransfer: DragDataTarget, url: string): string =>
  setAgentDragPayload(dataTransfer, AGENT_MODEL3D_DRAG_MIME, url)

export const setAgentAttachmentDragPayload = (
  dataTransfer: DragDataTarget,
  attachment: ChatAttachment,
  options?: {
    ocrResult?: ChatMessage['ocrResult']
  }
): void => {
  const normalizedUrl = normalizeLocalMediaUrl(attachment.url)
  const normalizedAttachment: ChatAttachment = {
    ...attachment,
    url: normalizedUrl,
    ...(attachment.ocrResult || options?.ocrResult
      ? {
          ocrResult: attachment.ocrResult || options?.ocrResult
        }
      : {})
  }
  const itemType =
    attachment.type === 'model3d'
      ? 'model3d'
      : attachment.type === 'video'
        ? 'video'
        : attachment.type === 'image'
          ? 'image'
          : 'file'
  const payload = JSON.stringify({
    itemTypes: [itemType],
    attachments: [normalizedAttachment],
    ...(normalizedAttachment.ocrResult ? { ocrResult: normalizedAttachment.ocrResult } : {})
  })

  dataTransfer.setData(QAPP_IMAGE_DRAG_MIME, payload)
  dataTransfer.setData('text/plain', `${INTERNAL_IMAGE_DRAG_PREFIX}${payload}`)
  dataTransfer.setData('text/uri-list', normalizedUrl)
  dataTransfer.effectAllowed = 'copy'
}
