import { resolveLocalMediaPathFromUrl } from './chatPageShared'
import type { ChatAttachment, ChatMessage } from '@shared/api/svcLLMProxy'

export const isRepairImagesCommand = (text: string): boolean => /^\/repair[_-]images(?:\s|$)/i.test(text.trimStart())
export function parseRepairImagesCommand(text: string): boolean {
  if (!isRepairImagesCommand(text)) return false
  if (!/^\/repair[_-]images$/i.test(text.trim())) throw new Error('Use /repair-images without arguments.')
  return true
}
export type MissingImageReference = Readonly<{ messageIndex: number; attachmentIndex: number; url: string }>
export const REPAIR_IMAGE_CHECK_LIMIT = 128
export type ImageRepairScan = Readonly<{ missing: readonly MissingImageReference[]; checked: number; limited: boolean }>
/** Explicit user scan only. UNC/network paths and non-local URLs are never probed. */
export async function scanMissingLocalImages(
  messages: ChatMessage[],
  exists: (paths: string[]) => Promise<boolean[]>
): Promise<ImageRepairScan> {
  const candidates: Array<MissingImageReference & { path: string }> = []
  let limited = false
  for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
    const message = messages[messageIndex]
    // Running tools or explicitly unfinished attachment output are excluded.
    if (message.toolHistory?.some(tool => tool.status === 'running') ||
      message.attachments?.some(attachment => attachment.finishReason && attachment.finishReason !== 'stop')) continue
    for (let attachmentIndex = 0; attachmentIndex < (message.attachments?.length ?? 0); attachmentIndex++) {
      const attachment = message.attachments![attachmentIndex]
      if (attachment.type !== 'image' || !/^(?:file|local-media):\/\//i.test(attachment.url)) continue
      const path = resolveLocalMediaPathFromUrl(attachment.url)
      if (!path || /^(?:\/\/|\\\\)/.test(path) || !/^(?:[a-zA-Z]:[\\/]|\/(?!\/))/.test(path)) continue
      if (candidates.length >= REPAIR_IMAGE_CHECK_LIMIT) { limited = true; continue }
      candidates.push({ messageIndex, attachmentIndex, url: attachment.url, path })
    }
  }
  if (!candidates.length) return { missing: [], checked: 0, limited }
  const result = await exists(candidates.map(item => item.path))
  if (result.length !== candidates.length || result.some(item => typeof item !== 'boolean')) throw new Error('Image existence check unavailable.')
  return {
    missing: candidates.filter((_, index) => !result[index]).map(({ messageIndex, attachmentIndex, url }) => ({ messageIndex, attachmentIndex, url })),
    checked: candidates.length, limited
  }
}

export function projectConfirmedImageContext(
  messages: ChatMessage[], references: ReadonlyMap<ChatMessage, readonly MissingImageReference[]>
): ChatMessage[] {
  const attachments = new Set<ChatAttachment>()
  for (const [source, confirmed] of references) {
    for (const item of confirmed) {
      const attachment = source.attachments?.[item.attachmentIndex]
      if (attachment?.type === 'image' && attachment.url === item.url) attachments.add(attachment)
    }
  }
  return messages.map(message => {
    const confirmed = (message.attachments ?? []).flatMap((attachment, attachmentIndex) =>
      attachments.has(attachment) ? [{ messageIndex: 0, attachmentIndex, url: attachment.url }] : [])
    return confirmed.length ? replaceConfirmedMissingImages([message], confirmed)[0] : message
  })
}

/** Pure branch-context projection after explicit confirmation. Never mutate source history. */
export function replaceConfirmedMissingImages(messages: ChatMessage[], confirmed: readonly MissingImageReference[]): ChatMessage[] {
  return messages.map((message, messageIndex) => {
    const selected = confirmed.filter(item => item.messageIndex === messageIndex &&
      message.attachments?.[item.attachmentIndex]?.type === 'image' &&
      message.attachments[item.attachmentIndex].url === item.url)
    if (!selected.length) return message
    const indices = new Set(selected.map(item => item.attachmentIndex))
    return {
      ...message,
      content: `${message.content}${message.content ? '\n' : ''}${selected.map(() => '[Missing local image omitted from this branch context]').join('\n')}`,
      attachments: message.attachments?.filter((_, index) => !indices.has(index))
    }
  })
}
