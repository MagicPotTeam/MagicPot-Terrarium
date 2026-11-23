import { describe, expect, it } from 'vitest'
import type { ChatAttachment } from '@shared/api/svcLLMProxy'
import {
  QUEUED_SEND_INLINE_ATTACHMENT_MAX_CHARS,
  QUEUED_SENDS_INLINE_BUDGET_CHARS,
  UNAVAILABLE_QUEUED_ATTACHMENT_URL,
  isUnavailableQueuedAttachment,
  normalizeStoredQueuedSends,
  restoreQueuedSends,
  serializeQueuedSends,
  type PersistableQueuedSend
} from './chatQueuedSendPersistence'

const sha = 'a'.repeat(64)
const managedImage: ChatAttachment = {
  type: 'image',
  url: 'local-media:///managed/a.png',
  fileName: 'a.png',
  mimeType: 'image/png',
  media: {
    version: 1,
    kind: 'managed',
    relativePath: `originals/${sha}.png`,
    sha256: sha,
    sizeBytes: 5,
    mimeType: 'image/png',
    originalFileName: 'a.png'
  }
}
const inline = (chars: number, fileName = 'inline.png'): ChatAttachment => ({
  type: 'image',
  url: `data:image/png;base64,${'A'.repeat(chars - 'data:image/png;base64,'.length)}`,
  fileName,
  mimeType: 'image/png'
})
const userItem = (
  persistId: string,
  overrides: PersistableQueuedSend['overrides'],
  extra: Partial<PersistableQueuedSend> = {}
): PersistableQueuedSend => ({ id: 1, persistId, queuedAt: 7, overrides, ...extra })

describe('chatQueuedSendPersistence', () => {
  it('stores user items only, with their own text and hidden context, never callbacks or team context', () => {
    const stored = serializeQueuedSends([
      userItem(
        'composer',
        {
          content: 'lead text',
          composerSubmission: true,
          hiddenContext: 'GENERATED TEAM CONTEXT\n\nuser hidden',
          isQueuedComposerCurrent: () => true,
          onComposerSubmissionAccepted: () => undefined
        } as PersistableQueuedSend['overrides'],
        { fromComposer: true, originalComposerHiddenContext: 'user hidden' }
      ),
      userItem(
        'plain-composer',
        { content: 'typed', hiddenContext: 'composer hidden' },
        { fromComposer: true }
      ),
      userItem('edit', {
        content: 'edited',
        hiddenContext: 'canvas context',
        baseMessages: [{ role: 'user', content: 'old' }],
        targetSessionId: 'other-session'
      } as PersistableQueuedSend['overrides']),
      userItem('member', { content: 'member message' }, { queueKey: 'team-key' }),
      userItem('delivery', { content: 'delivery', onTeamRequestStarted: () => undefined }),
      userItem('resolve', { content: 'resolve', resolveAttachments: async () => [] }),
      { id: 2, overrides: { content: 'no persist id' } }
    ])
    expect(stored).toEqual([
      {
        id: 'composer',
        content: 'lead text',
        originalComposerHiddenContext: 'user hidden',
        queuedAt: 7
      },
      {
        id: 'plain-composer',
        content: 'typed',
        originalComposerHiddenContext: 'composer hidden',
        queuedAt: 7
      },
      { id: 'edit', content: 'edited', queuedAt: 7 }
    ])
    const json = JSON.stringify(stored)
    expect(json).not.toContain('GENERATED TEAM CONTEXT')
    expect(json).not.toContain('canvas context')
    expect(json).not.toContain('other-session')
    expect(json).not.toContain('baseMessages')
    expect(json).not.toContain('team-key')
  })

  it('keeps managed references and small inline images, and marks blob, broken and over-cap ones unavailable', () => {
    const [item] = serializeQueuedSends([
      userItem('attachments', {
        content: '',
        attachments: [
          managedImage,
          inline(1024, 'small.png'),
          { type: 'image', url: 'blob:file:///dead', fileName: 'blob.png', mimeType: 'image/png' },
          inline(QUEUED_SEND_INLINE_ATTACHMENT_MAX_CHARS + 1, 'large.png'),
          {
            ...managedImage,
            fileName: 'broken.png',
            media: { version: 1, kind: 'managed' } as never
          },
          { type: 'video', url: 'https://example.com/clip.mp4', fileName: 'clip.mp4' }
        ]
      })
    ])
    const attachments = item.attachments!
    expect(attachments).toHaveLength(6)
    expect(attachments[0]).toEqual(managedImage)
    expect(attachments[1].url).toBe(inline(1024).url)
    for (const index of [2, 3, 4]) {
      expect(isUnavailableQueuedAttachment(attachments[index])).toBe(true)
      expect(attachments[index].url).toBe(UNAVAILABLE_QUEUED_ATTACHMENT_URL)
      expect(attachments[index].media).toBeUndefined()
    }
    expect(attachments.map((attachment) => attachment.fileName)).toEqual([
      'a.png',
      'small.png',
      'blob.png',
      'large.png',
      'broken.png',
      'clip.mp4'
    ])
    expect(attachments[5].url).toBe('https://example.com/clip.mp4')
    expect(JSON.stringify(item).length).toBeLessThan(4096)
  })

  it('bounds all inline images of one queue together', () => {
    const each = QUEUED_SEND_INLINE_ATTACHMENT_MAX_CHARS - 10
    const count = Math.floor(QUEUED_SENDS_INLINE_BUDGET_CHARS / each) + 2
    const stored = serializeQueuedSends(
      Array.from({ length: count }, (_, index) =>
        userItem(`q${index}`, { content: `item ${index}`, attachments: [inline(each)] })
      )
    )
    const kept = stored.filter((item) => !isUnavailableQueuedAttachment(item.attachments![0]))
    expect(kept.length).toBe(Math.floor(QUEUED_SENDS_INLINE_BUDGET_CHARS / each))
    expect(stored).toHaveLength(count)
    expect(JSON.stringify(stored).length).toBeLessThan(QUEUED_SENDS_INLINE_BUDGET_CHARS + 8192)
  })

  it('normalizes stored items read back and drops malformed or duplicated ones', () => {
    const normalized = normalizeStoredQueuedSends(
      [
        { id: 'q1', content: 'one', queuedAt: 3, extra: 'dropped' },
        { id: 'q1', content: 'duplicate', queuedAt: 4 },
        { id: '', content: 'no id' },
        { id: 'q2', content: '', attachments: [{ type: 'image', url: 'blob:x' }] },
        { id: 'q3', content: '' },
        'junk'
      ],
      (value) => (Array.isArray(value) ? (value as ChatAttachment[]) : [])
    )
    expect(normalized.map((item) => item.id)).toEqual(['q1', 'q2'])
    expect(normalized[0]).toEqual({ id: 'q1', content: 'one', queuedAt: 3 })
    expect(isUnavailableQueuedAttachment(normalized[1].attachments![0])).toBe(true)
  })

  it('restores stored items paused in front of the queue and skips ids it already holds', () => {
    let nextId = 100
    const create = (fields: { persistId: string; content: string; queuedAt: number }) =>
      ({
        id: ++nextId,
        persistId: fields.persistId,
        queuedAt: fields.queuedAt,
        overrides: { content: fields.content },
        paused: true,
        heldByStop: 1
      }) as PersistableQueuedSend
    const inMemory: PersistableQueuedSend[] = [
      { id: 1, persistId: 'q2', overrides: { content: 'two' } }
    ]
    const restored = restoreQueuedSends(
      [
        { id: 'q1', content: 'one', queuedAt: 1 },
        { id: 'q2', content: 'two', queuedAt: 2 }
      ],
      inMemory,
      create
    )
    expect(restored?.map((item) => item.persistId)).toEqual(['q1', 'q2'])
    expect(restored?.[0]).toMatchObject({ id: 101, paused: true, heldByStop: 1 })
    expect(restored?.[1]).toBe(inMemory[0])
    expect(
      restoreQueuedSends([{ id: 'q2', content: 'two', queuedAt: 2 }], inMemory, create)
    ).toBeUndefined()
    // What is restored is stored again unchanged: no rewrite after a reload.
    const roundTrip = serializeQueuedSends(restored)
    expect(roundTrip.map((item) => item.id)).toEqual(['q1', 'q2'])
  })
})
