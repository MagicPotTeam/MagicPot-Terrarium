import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatAttachment } from '@shared/api/svcLLMProxy'
import type { MediaReference } from '@shared/mediaReference'

const fake = vi.hoisted(() => ({ save: vi.fn() }))
vi.mock('./chatStorage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./chatStorage')>()),
  saveSessionToDB: fake.save
}))

import type { ChatSession } from './chatStorage'
import { ChatSessionSaveBaseline } from './chatSaveBaseline'
import {
  applyInlineAttachmentReplacements,
  CHAT_STORED_INLINE_ATTACHMENT_MAX_CHARS,
  ChatInlineAttachmentGuard,
  INLINE_ATTACHMENT_IMPORT_RETRY_MS,
  isOversizedInlineImageAttachment,
  type InlineAttachmentReplacement
} from './chatInlineAttachmentGuard'

// FIX-PLAN item 4, part 1: at the save boundary an image whose url is a data: URL longer than
// about 64 KB is imported into managed media first and the record keeps the reference. A failed
// import keeps the inline image; the save is never failed or emptied by the guard.

const inlinePng = (seed: string, chars = CHAT_STORED_INLINE_ATTACHMENT_MAX_CHARS + 16): string => {
  const prefix = 'data:image/png;base64,'
  const body = `${seed}${'A'.repeat(chars)}`.slice(0, chars - prefix.length)
  return `${prefix}${body}`
}

const reference = (id: string): MediaReference => ({
  version: 1,
  kind: 'managed',
  relativePath: `originals/${id.slice(0, 2)}/${id}.png`,
  sha256: id,
  sizeBytes: 4096,
  mimeType: 'image/png',
  originalFileName: `${id}.png`,
  status: 'ready'
})

const managedFor = (attachment: ChatAttachment, id: string): ChatAttachment => ({
  ...attachment,
  url: `local-media:///managed/originals/${id}.png`,
  media: reference(id),
  mimeType: 'image/png',
  sizeBytes: 4096
})

const image = (url: string, extra: Partial<ChatAttachment> = {}): ChatAttachment => ({
  type: 'image',
  url,
  fileName: 'image.png',
  ...extra
})

const idFor = (index: number): string => String(index).padStart(2, '0').repeat(32)

/** An importer that hands out one managed id per distinct url, in call order. */
const createImporter = () => {
  const ids = new Map<string, string>()
  const importer = vi.fn(async (attachment: ChatAttachment) => {
    if (!ids.has(attachment.url)) ids.set(attachment.url, idFor(ids.size + 1))
    return managedFor(attachment, ids.get(attachment.url)!)
  })
  return { importer, ids }
}

const allAttachments = (session: ChatSession): ChatAttachment[] => [
  ...session.messages.flatMap((message) => message.attachments || []),
  ...(session.compactedMessages || []).flatMap((message) => message.attachments || []),
  ...(session.contextCompression?.replayImageMessages || []).flatMap(
    (message) => message.attachments || []
  ),
  ...(session.draft?.pendingAttachments || []),
  ...(session.draft?.queuedSends || []).flatMap((item) => item.attachments || [])
]

describe('isOversizedInlineImageAttachment', () => {
  it('selects only long base64 images of a format the managed store holds', () => {
    expect(isOversizedInlineImageAttachment(image(inlinePng('a')))).toBe(true)
    // At the limit, or a short inline image: written as it is.
    expect(
      isOversizedInlineImageAttachment(
        image(inlinePng('a', CHAT_STORED_INLINE_ATTACHMENT_MAX_CHARS))
      )
    ).toBe(false)
    expect(isOversizedInlineImageAttachment(image(inlinePng('a', 2048)))).toBe(false)
    expect(
      isOversizedInlineImageAttachment(
        image(inlinePng('a').replace('data:image/png', 'data:image/svg+xml'))
      )
    ).toBe(false)
    expect(isOversizedInlineImageAttachment({ ...image(inlinePng('a')), type: 'file' })).toBe(false)
    expect(isOversizedInlineImageAttachment(image('local-media:///managed/a.png'))).toBe(false)
    expect(isOversizedInlineImageAttachment(null)).toBe(false)
  })
})

describe('ChatInlineAttachmentGuard', () => {
  it('replaces every oversized inline image of a conversation and keeps everything else', async () => {
    const big = inlinePng('message')
    const shared = inlinePng('shared')
    const small = inlinePng('small', 4096)
    const untouched = { role: 'assistant' as const, content: 'no images' }
    const session: ChatSession = {
      id: 'guard-session',
      title: 'Guard',
      messages: [
        untouched,
        {
          role: 'user',
          content: 'two images',
          attachments: [
            image(big, { hiddenFromChatView: true, metadata: { source: 'canvas' } }),
            image(small),
            image(shared)
          ]
        }
      ],
      compactedMessages: [{ role: 'user', content: 'old', attachments: [image(shared)] }],
      contextCompression: {
        replayImageMessages: [{ role: 'user', content: 'replay', attachments: [image(big)] }]
      } as ChatSession['contextCompression'],
      draft: {
        inputValue: 'draft',
        pendingAttachments: [image(inlinePng('draft'))],
        pendingHiddenContext: '',
        updatedAt: 1,
        queuedSends: [
          {
            id: 'queued',
            content: 'queued',
            attachments: [image(inlinePng('queued'))],
            queuedAt: 1
          }
        ],
        queuedSendsUpdatedAt: 1
      }
    }
    const { importer } = createImporter()
    const guard = new ChatInlineAttachmentGuard(importer)

    expect(guard.needsImport(session)).toBe(true)
    const { session: stored, replacements } = await guard.externalize(session)

    // One import per distinct inline image, also when several places hold it.
    expect(importer).toHaveBeenCalledTimes(4)
    expect(replacements.size).toBe(4)
    const longInline = allAttachments(stored).filter(
      (attachment) =>
        attachment.url.startsWith('data:') &&
        attachment.url.length > CHAT_STORED_INLINE_ATTACHMENT_MAX_CHARS
    )
    expect(longInline).toEqual([])
    // Nothing is dropped or reordered, and every other field stays.
    expect(allAttachments(stored)).toHaveLength(allAttachments(session).length)
    expect(stored.messages[1].attachments?.[0]).toMatchObject({
      hiddenFromChatView: true,
      metadata: { source: 'canvas' },
      fileName: 'image.png',
      media: { kind: 'managed' }
    })
    expect(stored.messages[1].attachments?.[1]).toBe(session.messages[1].attachments?.[1])
    expect(stored.messages[1].attachments?.[2]?.url).toBe(
      stored.compactedMessages?.[0].attachments?.[0]?.url
    )
    expect(stored.messages[0]).toBe(untouched)
    expect(stored.draft?.inputValue).toBe('draft')
    expect(stored.draft?.queuedSends?.[0]).toMatchObject({ id: 'queued', content: 'queued' })
    // The live object is never changed in place.
    expect(session.messages[1].attachments?.[0]?.url).toBe(big)
    expect(guard.needsImport(stored)).toBe(false)
  })

  it('returns the same object and imports nothing for a conversation without inline images', async () => {
    const session: ChatSession = {
      id: 'clean',
      title: 'Clean',
      messages: [
        {
          role: 'user',
          content: 'managed',
          attachments: [managedFor(image('placeholder'), idFor(9)), image(inlinePng('s', 1024))]
        }
      ]
    }
    const { importer } = createImporter()
    const guard = new ChatInlineAttachmentGuard(importer)
    expect(guard.needsImport(session)).toBe(false)
    await expect(guard.externalize(session)).resolves.toMatchObject({ session })
    expect(importer).not.toHaveBeenCalled()
  })

  it('keeps an image inline when its import fails, and does not try it again for a while', async () => {
    let now = 1_000
    const failing = inlinePng('failing')
    const working = inlinePng('working')
    const importer = vi.fn(async (attachment: ChatAttachment) => {
      if (attachment.url === failing) throw new Error('main refused it')
      return managedFor(attachment, idFor(1))
    })
    const guard = new ChatInlineAttachmentGuard(importer, () => now)
    const session: ChatSession = {
      id: 'partial',
      title: 'Partial',
      messages: [{ role: 'user', content: '', attachments: [image(failing), image(working)] }]
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const { session: stored } = await guard.externalize(session)
      expect(stored.messages[0].attachments?.map((attachment) => attachment.url)).toEqual([
        failing,
        `local-media:///managed/originals/${idFor(1)}.png`
      ])
      // The next save does not wait for the same failing import again.
      expect(guard.needsImport(stored)).toBe(false)
      now += INLINE_ATTACHMENT_IMPORT_RETRY_MS + 1
      expect(guard.needsImport(stored)).toBe(true)
      // An import that returns no managed reference counts as a failure, not as a replacement.
      importer.mockResolvedValueOnce(image('data:,'))
      await expect(guard.externalize(stored)).resolves.toMatchObject({ session: stored })
    } finally {
      warn.mockRestore()
    }
  })

  it('shares one import between concurrent saves of the same image', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const url = inlinePng('concurrent')
    const importer = vi.fn(async (attachment: ChatAttachment) => {
      await gate
      return managedFor(attachment, idFor(3))
    })
    const guard = new ChatInlineAttachmentGuard(importer)
    const session = (id: string): ChatSession => ({
      id,
      title: id,
      messages: [{ role: 'user', content: '', attachments: [image(url)] }]
    })
    const first = guard.externalize(session('a'))
    const second = guard.externalize(session('b'))
    release()
    const results = await Promise.all([first, second])
    expect(importer).toHaveBeenCalledTimes(1)
    for (const result of results) {
      expect(result.session.messages[0].attachments?.[0]?.media).toEqual(reference(idFor(3)))
    }
    // A retried save shortly after reuses the finished import.
    await guard.externalize(session('c'))
    expect(importer).toHaveBeenCalledTimes(1)
  })

  it('applies finished imports to a newer live object by url', () => {
    const url = inlinePng('live')
    const replacement: InlineAttachmentReplacement = {
      url: 'local-media:///managed/originals/live.png',
      media: reference(idFor(4)),
      mimeType: 'image/png',
      sizeBytes: 4096
    }
    const live: ChatSession = {
      id: 'live',
      title: 'Live',
      messages: [
        { role: 'user', content: 'q', attachments: [image(url)] },
        { role: 'assistant', content: 'streamed later' }
      ]
    }
    const next = applyInlineAttachmentReplacements(live, new Map([[url, replacement]]))
    expect(next).not.toBe(live)
    expect(next.messages[0].attachments?.[0]).toMatchObject(replacement)
    expect(next.messages[1]).toBe(live.messages[1])
    expect(applyInlineAttachmentReplacements(next, new Map([[url, replacement]]))).toBe(next)
  })
})

describe('the save baseline with the inline image guard', () => {
  beforeEach(() => {
    fake.save.mockReset()
    fake.save.mockResolvedValue(undefined)
  })

  const install = (guard: ChatInlineAttachmentGuard, live: { session: ChatSession }) => {
    const baseline = new ChatSessionSaveBaseline()
    const adopt = vi.fn((_scope: string, session: ChatSession, stored: ChatSession) => {
      if (live.session === session) live.session = stored
      return stored
    })
    baseline.setStoredForm({
      prepare: (_scope, session) =>
        guard.needsImport(session)
          ? guard.externalize(session).then((result) => result.session)
          : session,
      adopt
    })
    return { baseline, adopt }
  }

  it('writes the managed reference and makes the written form the live, acknowledged object', async () => {
    const url = inlinePng('save')
    const live = {
      session: {
        id: 'save',
        title: 'Save',
        messages: [{ role: 'assistant', content: 'image', attachments: [image(url)] }]
      } as ChatSession
    }
    const { importer } = createImporter()
    const { baseline, adopt } = install(new ChatInlineAttachmentGuard(importer), live)
    const original = live.session

    const saved = await baseline.persistLatest(
      'scope',
      'save',
      () => live.session,
      () => null
    )

    expect(fake.save).toHaveBeenCalledTimes(1)
    const payload = fake.save.mock.calls[0][0] as ChatSession
    expect(JSON.stringify(payload)).not.toContain('data:image/png;base64')
    expect(payload.messages[0].attachments?.[0]?.media).toMatchObject({ kind: 'managed' })
    expect(adopt).toHaveBeenCalledWith('scope', original, saved)
    expect(saved).toBe(live.session)
    expect(baseline.isAcknowledgementCurrent('scope', saved!)).toBe(true)
  })

  it('saves the inline image as it is when the import fails', async () => {
    const url = inlinePng('refused')
    const live = {
      session: {
        id: 'refused',
        title: 'Refused',
        messages: [{ role: 'user', content: '', attachments: [image(url)] }]
      } as ChatSession
    }
    const importer = vi.fn(async () => {
      throw new Error('store unavailable')
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const { baseline, adopt } = install(new ChatInlineAttachmentGuard(importer), live)
      const original = live.session
      const saved = await baseline.persistLatest(
        'scope',
        'refused',
        () => live.session,
        () => null
      )
      expect(saved).toBe(original)
      expect(adopt).not.toHaveBeenCalled()
      expect(fake.save).toHaveBeenCalledTimes(1)
      expect((fake.save.mock.calls[0][0] as ChatSession).messages[0].attachments?.[0]?.url).toBe(
        url
      )
      expect(baseline.isAcknowledgementCurrent('scope', original)).toBe(true)
    } finally {
      warn.mockRestore()
    }
  })

  it('does not wait or import for a conversation without inline images', async () => {
    const live = {
      session: {
        id: 'plain',
        title: 'Plain',
        messages: [{ role: 'user', content: 'text only' }]
      } as ChatSession
    }
    const { importer } = createImporter()
    const prepare = vi.fn((_scope: string, session: ChatSession) => session)
    const baseline = new ChatSessionSaveBaseline()
    baseline.setStoredForm({ prepare, adopt: vi.fn() })
    const original = live.session
    const saved = await baseline.persistLatest(
      'scope',
      'plain',
      () => live.session,
      () => null
    )
    expect(saved).toBe(original)
    expect(prepare).toHaveBeenCalledTimes(1)
    expect(importer).not.toHaveBeenCalled()
    expect(fake.save.mock.calls[0][0]).toEqual(original)
  })
})
