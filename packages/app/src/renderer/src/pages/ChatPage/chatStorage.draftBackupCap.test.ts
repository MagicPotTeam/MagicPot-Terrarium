import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatAttachment } from '@shared/api/svcLLMProxy'
import type { ChatDraftQueuedSend, ChatSessionDraft } from './chatStorage'

vi.mock('../../utils/windowUtils', () => ({ api: () => ({}) }))

import {
  CHAT_DRAFT_BACKUP_MAX_CHARS,
  CHAT_DRAFT_BACKUP_MAX_INLINE_ATTACHMENT_CHARS,
  readSessionDraftBackup,
  writeSessionDraftBackup,
  writeSessionQueuedSendsBackup
} from './chatStorage'

// FIX-PLAN item 4, part 3: the localStorage draft backup has a cap for the inline images of the
// whole record (the queue included), and a much larger one for its whole length. Over a cap
// nothing is built or written and the older backup stays; the session record keeps the whole
// draft. A draft with managed images stays far below the caps; a long text draft is kept.

const SCOPE = 'project-a.pane-1'
const KEY = `magicpot-chat-draft:${SCOPE}:session-1`

const managedImage = (index: number): ChatAttachment => {
  const id = String(index).padStart(2, '0').repeat(32)
  return {
    type: 'image',
    url: `local-media:///managed/user-output/chat-attachments/originals/${id.slice(0, 2)}/${id}.png`,
    fileName: `image-${index}.png`,
    mimeType: 'image/png',
    sizeBytes: 812_345,
    sourceWidth: 1184,
    sourceHeight: 1184,
    media: {
      version: 1,
      kind: 'managed',
      sha256: id,
      relativePath: `user-output/chat-attachments/originals/${id.slice(0, 2)}/${id}.png`,
      sizeBytes: 812_345,
      mimeType: 'image/png',
      originalFileName: `image-${index}.png`,
      status: 'ready'
    }
  }
}
const inlineImage = (chars: number): ChatAttachment => ({
  type: 'image',
  url: `data:image/png;base64,${'A'.repeat(chars)}`,
  fileName: 'inline.png'
})
const draft = (
  attachments: ChatAttachment[],
  inputValue = 'draft',
  updatedAt = 10
): ChatSessionDraft => ({
  inputValue,
  pendingAttachments: attachments,
  pendingHiddenContext: '',
  updatedAt
})

/** Lengths of every string JSON.stringify builds while `run` runs. */
const stringifiedLengths = (run: () => void): number[] => {
  const original = JSON.stringify
  const lengths: number[] = []
  const spy = vi.spyOn(JSON, 'stringify').mockImplementation(((
    ...args: Parameters<typeof JSON.stringify>
  ) => {
    const out = original(...args)
    lengths.push(typeof out === 'string' ? out.length : 0)
    return out
  }) as typeof JSON.stringify)
  try {
    run()
  } finally {
    spy.mockRestore()
  }
  return lengths
}

beforeEach(() => localStorage.clear())
afterEach(() => localStorage.clear())

describe('the draft backup cap', () => {
  it('keeps a draft with eight managed images, far below the cap', () => {
    writeSessionDraftBackup(
      'session-1',
      10,
      draft(Array.from({ length: 8 }, (_, i) => managedImage(i))),
      SCOPE
    )
    const raw = localStorage.getItem(KEY)
    expect(raw).toBeTruthy()
    expect(raw!.length).toBeLessThan(10 * 1024)
    expect(readSessionDraftBackup('session-1', SCOPE)?.draft?.pendingAttachments).toHaveLength(8)
  })

  it('does not build or write a record over the cap, and keeps the older backup', () => {
    writeSessionDraftBackup('session-1', 10, draft([managedImage(1)], 'older'), SCOPE)
    const older = localStorage.getItem(KEY)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      // Eight inline images of about 1.1 M characters each, as the canvas used to deliver them.
      const lengths = stringifiedLengths(() =>
        writeSessionDraftBackup(
          'session-1',
          20,
          draft(
            Array.from({ length: 8 }, () => inlineImage(1_100_000)),
            'newer',
            20
          ),
          SCOPE
        )
      )
      expect(Math.max(0, ...lengths)).toBeLessThan(CHAT_DRAFT_BACKUP_MAX_INLINE_ATTACHMENT_CHARS)
      // A text draft over the whole record's cap is not written either.
      writeSessionDraftBackup(
        'session-1',
        30,
        draft([], 'x'.repeat(CHAT_DRAFT_BACKUP_MAX_CHARS), 30),
        SCOPE
      )
    } finally {
      warn.mockRestore()
    }
    expect(localStorage.getItem(KEY)).toBe(older)
    expect(readSessionDraftBackup('session-1', SCOPE)?.draft?.inputValue).toBe('older')
  })

  it('keeps a long text draft, such as a pasted log, as the synchronous safety net', () => {
    writeSessionDraftBackup('session-1', 10, draft([managedImage(1)], 'older'), SCOPE)
    // Far over the inline image cap, far below the record's cap: text is not an inline image.
    const log = 'log line\n'.repeat(100_000)
    expect(log.length).toBeGreaterThan(CHAT_DRAFT_BACKUP_MAX_INLINE_ATTACHMENT_CHARS * 3)
    writeSessionDraftBackup('session-1', 20, draft([managedImage(1)], log, 20), SCOPE)
    const backup = readSessionDraftBackup('session-1', SCOPE)
    expect(backup?.draft?.inputValue).toBe(log)
    expect(backup?.draft?.pendingAttachments).toHaveLength(1)
    expect(backup?.updatedAt).toBe(20)
  })

  it('counts the queue in the inline image cap, and still writes an emptied queue as a removal marker', () => {
    // The composer holds an inline image the store cannot hold (kept inline by design).
    writeSessionDraftBackup(
      'session-1',
      10,
      draft([inlineImage(100_000)], 'x'.repeat(40_000)),
      SCOPE
    )
    const queued = (id: string): ChatDraftQueuedSend => ({
      id,
      content: `queued ${id}`,
      // Below the per-image limit of the queue, together within its own budget.
      attachments: [inlineImage(60_000)],
      queuedAt: 1
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      expect(
        writeSessionQueuedSendsBackup('session-1', [queued('a'), queued('b')], 100, SCOPE)
      ).toBe(true)
      const withQueue = localStorage.getItem(KEY)!
      // One more item takes the record's inline images over the cap: refused, the older queue kept.
      expect(
        writeSessionQueuedSendsBackup(
          'session-1',
          [queued('a'), queued('b'), queued('c')],
          200,
          SCOPE
        )
      ).toBe(false)
      expect(localStorage.getItem(KEY)).toBe(withQueue)
      // The composer write keeps to the inline cap with the queue it carries; its text does not
      // count toward it.
      writeSessionDraftBackup(
        'session-1',
        300,
        draft([inlineImage(100_000), inlineImage(50_000)], 'y', 300),
        SCOPE
      )
      expect(readSessionDraftBackup('session-1', SCOPE)?.draft?.inputValue).toBe('x'.repeat(40_000))
      writeSessionDraftBackup(
        'session-1',
        310,
        draft([inlineImage(100_000)], 'y'.repeat(400_000), 310),
        SCOPE
      )
      expect(readSessionDraftBackup('session-1', SCOPE)?.draft?.inputValue).toBe(
        'y'.repeat(400_000)
      )
      // Accepting the items empties the queue: the removal marker is written.
      expect(writeSessionQueuedSendsBackup('session-1', [], 400, SCOPE)).toBe(true)
    } finally {
      warn.mockRestore()
    }
    const record = readSessionDraftBackup('session-1', SCOPE)
    expect(record?.queuedSends).toEqual([])
    expect(record?.queuedSendsUpdatedAt).toBe(400)
    expect(record?.draft?.inputValue).toBe('y'.repeat(400_000))
  })
})
