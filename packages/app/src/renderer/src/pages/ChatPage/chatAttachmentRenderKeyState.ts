import type { ChatAttachment } from '../QuickAppPage/QAppExecutePanel/qAppExecuteInputs/api/LLM'

export interface ChatAttachmentRenderKeyState {
  readonly nextId: number
  readonly entries: readonly {
    readonly type: ChatAttachment['type']
    readonly url: string
    readonly mediaIdentity: string
    readonly key: string
  }[]
  readonly keys: readonly string[]
}

interface RenderKeyCandidates {
  keys: string[]
  nextIndex: number
}

function getMediaIdentity(attachment: ChatAttachment): string {
  const media = attachment.media
  return media?.kind === 'managed'
    ? `managed:${media.version ?? ''}:${media.relativePath ?? ''}:${media.sha256 ?? ''}`
    : ''
}

export function createChatAttachmentRenderKeyState(
  attachments: readonly ChatAttachment[]
): ChatAttachmentRenderKeyState {
  return reconcileChatAttachmentRenderKeyState({ nextId: 0, entries: [], keys: [] }, attachments)
}

/** Derive keys without encoding image URLs or retaining sources absent from the current list. */
export function reconcileChatAttachmentRenderKeyState(
  previous: ChatAttachmentRenderKeyState,
  attachments: readonly ChatAttachment[]
): ChatAttachmentRenderKeyState {
  if (
    previous.entries.length === attachments.length &&
    attachments.every((attachment, index) => {
      const entry = previous.entries[index]
      return (
        entry.type === attachment.type &&
        entry.url === attachment.url &&
        entry.mediaIdentity === getMediaIdentity(attachment)
      )
    })
  ) {
    return previous
  }

  const candidatesBySource = new Map<
    ChatAttachment['type'],
    Map<string, Map<string, RenderKeyCandidates>>
  >()
  for (const entry of previous.entries) {
    let candidatesByUrl = candidatesBySource.get(entry.type)
    if (!candidatesByUrl) {
      candidatesByUrl = new Map()
      candidatesBySource.set(entry.type, candidatesByUrl)
    }
    let candidatesByMedia = candidatesByUrl.get(entry.url)
    if (!candidatesByMedia) {
      candidatesByMedia = new Map()
      candidatesByUrl.set(entry.url, candidatesByMedia)
    }
    let candidates = candidatesByMedia.get(entry.mediaIdentity)
    if (!candidates) {
      candidates = { keys: [], nextIndex: 0 }
      candidatesByMedia.set(entry.mediaIdentity, candidates)
    }
    candidates.keys.push(entry.key)
  }

  let nextId = previous.nextId
  const entries = attachments.map((attachment) => {
    const type = attachment.type
    const url = attachment.url
    const mediaIdentity = getMediaIdentity(attachment)
    const candidates = candidatesBySource.get(type)?.get(url)?.get(mediaIdentity)
    let key: string | undefined
    if (candidates) {
      key = candidates.keys[candidates.nextIndex]
      candidates.nextIndex += 1
    }
    // Snapshot primitive identity fields so an in-place attachment mutation is still detected.
    return { type, url, mediaIdentity, key: key ?? `chat-attachment:${nextId++}` }
  })

  return { nextId, entries, keys: entries.map((entry) => entry.key) }
}
