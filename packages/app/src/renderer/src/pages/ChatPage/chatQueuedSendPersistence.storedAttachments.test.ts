import { describe, expect, it } from 'vitest'
import type { ChatAttachment } from '@shared/api/svcLLMProxy'
import {
  adoptStoredQueuedAttachments,
  serializeQueuedSends,
  type PersistableQueuedSend
} from './chatQueuedSendPersistence'

// FIX-PLAN item 4 review: a queued item's images imported into managed media are stored at once,
// but the item keeps its blob: URL for sending until a stored copy of the queue holds the
// reference. A reference only this renderer knows of is invisible to the reference scanner, so
// the cleanup could remove its file while the blob still works.

const blob: ChatAttachment = {
  type: 'image',
  url: 'blob:file:///queued-1',
  fileName: 'pasted.png',
  mimeType: 'image/png'
}
const id = 'a'.repeat(64)
const managed: ChatAttachment = {
  ...blob,
  url: `local-media:///managed/originals/${id}.png`,
  media: {
    version: 1,
    kind: 'managed',
    sha256: id,
    relativePath: `originals/aa/${id}.png`,
    sizeBytes: 12,
    mimeType: 'image/png',
    originalFileName: 'pasted.png'
  }
}
const kept: ChatAttachment = { type: 'image', url: 'https://example.com/kept.png' }

const queuedItem = (overrides: Partial<PersistableQueuedSend> = {}): PersistableQueuedSend => {
  const attachments = [blob, kept]
  return {
    id: 1,
    persistId: 'p-1',
    queuedAt: 5,
    fromComposer: true,
    overrides: { content: 'look', attachments },
    storedAttachments: { source: attachments, attachments: [managed, kept] },
    ...overrides
  }
}

describe('queued images imported into managed media', () => {
  it('stores the references while the item keeps its blob: URL', () => {
    const item = queuedItem()
    const [stored] = serializeQueuedSends([item])
    expect(stored.attachments?.map((attachment) => attachment.url)).toEqual([managed.url, kept.url])
    expect(item.overrides?.attachments?.[0]).toBe(blob)
  })

  it('does not store an imported form that no longer stands for the attachments', () => {
    const item = queuedItem()
    const edited = { ...item, overrides: { content: 'look', attachments: [blob] } }
    const [stored] = serializeQueuedSends([edited])
    // As before: a blob: URL is kept as an unavailable attachment, never as the stale import.
    expect(stored.attachments?.[0]?.url).toBe('data:,')
  })

  it('takes the references into use only once a stored copy holds them', () => {
    const item = queuedItem()
    // The copy written before the import finished (the blob kept as an unavailable tile).
    expect(
      adoptStoredQueuedAttachments(
        [item],
        serializeQueuedSends([{ ...item, storedAttachments: undefined }])
      )
    ).toBeNull()
    // Nothing stored the queue (the backup over its cap, the record in conflict).
    expect(adoptStoredQueuedAttachments([item], [])).toBeNull()

    const adopted = adoptStoredQueuedAttachments([item], serializeQueuedSends([item]))
    expect(adopted?.released).toEqual([blob.url])
    expect(adopted?.queue[0].overrides?.attachments).toEqual([managed, kept])
    expect(adopted?.queue[0].storedAttachments).toBeUndefined()
    expect(adopted?.queue[0].persistId).toBe('p-1')
  })

  it('leaves an item that is being sent as it is', () => {
    const item = queuedItem({ inFlight: true })
    expect(adoptStoredQueuedAttachments([item], serializeQueuedSends([item]))).toBeNull()
  })
})
