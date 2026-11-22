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
  InlineAttachmentBackgroundImports,
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

  it('imports one queued inline image, and gives back anything it cannot import', async () => {
    const { importer } = createImporter()
    const guard = new ChatInlineAttachmentGuard(importer)
    const big = image(inlinePng('queued-one'), { metadata: { queued: true } })
    const small = image(inlinePng('queued-small', 1024))
    const imported = await guard.importInlineImage(big)
    expect(imported).toMatchObject({ metadata: { queued: true }, media: { kind: 'managed' } })
    expect(imported.url).toMatch(/^local-media:/)
    await expect(guard.importInlineImage(small)).resolves.toBe(small)
    // The same image saved with the conversation later reuses this import.
    await guard.externalize({
      id: 'later',
      title: 'Later',
      messages: [{ role: 'user', content: '', attachments: [image(big.url)] }]
    })
    expect(importer).toHaveBeenCalledTimes(1)

    importer.mockRejectedValueOnce(new Error('store unavailable'))
    const refused = image(inlinePng('queued-refused'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      await expect(guard.importInlineImage(refused)).resolves.toBe(refused)
    } finally {
      warn.mockRestore()
    }
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

describe('the guard outside the save chain', () => {
  const conversation = (...urls: string[]): ChatSession => ({
    id: 'background',
    title: 'Background',
    messages: urls.map((url) => ({ role: 'assistant', content: '', attachments: [image(url)] }))
  })

  it('applies finished imports without waiting and says which are still to come', async () => {
    const first = inlinePng('known')
    const second = inlinePng('unknown')
    const { importer } = createImporter()
    const guard = new ChatInlineAttachmentGuard(importer)
    const session = conversation(first, second)

    const before = guard.externalizeKnown(session)
    expect(before.session).toBe(session)
    expect(before.pending).toBe(true)
    expect(importer).not.toHaveBeenCalled()

    const [firstImage, secondImage] = session.messages.map((message) => message.attachments![0])
    await guard.importInlineImage(firstImage)
    const after = guard.externalizeKnown(session)
    expect(after.pending).toBe(true)
    expect(after.session.messages[0].attachments?.[0]?.media).toMatchObject({ kind: 'managed' })
    expect(after.session.messages[1].attachments?.[0]?.url).toBe(second)

    await guard.importInlineImage(secondImage)
    expect(guard.externalizeKnown(session).pending).toBe(false)
    expect(importer).toHaveBeenCalledTimes(2)
  })

  it('never reads a new large image on the save path, and hashes it in slices outside it', async () => {
    const { importer } = createImporter()
    const guard = new ChatInlineAttachmentGuard(importer)
    const fresh = conversation(inlinePng('fresh', 200_000))
    // On the save path a new image object is not hashed (about 3-5 ms per MB, on the main thread):
    // it counts as still to import. Before, every character was read here.
    const charCodeAt = vi.spyOn(String.prototype, 'charCodeAt')
    let reads: number
    try {
      expect(guard.needsImport(fresh)).toBe(true)
      expect(guard.externalizeKnown(fresh)).toMatchObject({ session: fresh, pending: true })
      reads = charCodeAt.mock.calls.length
    } finally {
      charCodeAt.mockRestore()
    }
    expect(reads).toBeLessThan(1_000)

    // Outside it, a large image is hashed a slice at a time: other work runs before its import.
    const large = conversation(inlinePng('large', 1_200_000))
    let importsWhenOtherWorkRan = -1
    setTimeout(() => (importsWhenOtherWorkRan = importer.mock.calls.length), 0)
    const { session: stored } = await guard.externalize(large)
    expect(importsWhenOtherWorkRan).toBe(0)
    expect(stored.messages[0].attachments?.[0]?.url).toMatch(/^local-media:/)
    // Hashed once: the next save of the same object writes the reference without waiting.
    const again = guard.externalizeKnown(large)
    expect(again.pending).toBe(false)
    expect(again.session.messages[0].attachments?.[0]?.url).toMatch(/^local-media:/)
    expect(importer).toHaveBeenCalledTimes(1)
  })

  it('imports once per conversation at a time, takes up requests made meanwhile, and keeps the scanner waiting', async () => {
    const first = inlinePng('first')
    const later = inlinePng('later')
    const releases: Array<() => void> = []
    const { importer: managed } = createImporter()
    const importer = vi.fn(async (attachment: ChatAttachment) => {
      await new Promise<void>((resolve) => releases.push(resolve))
      return managed(attachment)
    })
    const guard = new ChatInlineAttachmentGuard(importer)
    const written: Array<string[]> = []
    const onImported = vi.fn(
      async (_scope: string, _id: string, replacements: ReadonlyMap<string, unknown>) => {
        written.push([...replacements.keys()])
      }
    )
    const close = vi.fn()
    const open = vi.fn(() => close)
    const imports = new InlineAttachmentBackgroundImports(guard, onImported, open)

    imports.request('scope', conversation(first))
    imports.request('scope', conversation(first))
    await vi.waitFor(() => expect(importer).toHaveBeenCalledTimes(1))
    expect(imports.isRunning('scope', 'background')).toBe(true)
    // A save while the import runs: a newer image arrived.
    imports.request('scope', conversation(first, later))
    releases.shift()!()
    await vi.waitFor(() => expect(importer).toHaveBeenCalledTimes(2))
    releases.shift()!()
    await vi.waitFor(() => expect(imports.isRunning('scope', 'background')).toBe(false))

    expect(importer.mock.calls.map(([attachment]) => attachment.url)).toEqual([first, later])
    expect(written).toEqual([[first], [first, later]])
    expect(open).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledTimes(1)
  })
})

describe('the guard caches', () => {
  /** Two images that agree at both ends and in the middle, and differ in between. */
  const twins = (): [string, string] => {
    const prefix = 'data:image/png;base64,'
    const length = 64 * 1024
    const body = (marker: string) => {
      const chars = 'A'.repeat(length).split('')
      chars[10_000] = marker
      return chars.join('')
    }
    return [`${prefix}${body('B')}`, `${prefix}${body('C')}`]
  }

  it('never takes one image for another that differs only where a sample would not look', async () => {
    const [first, second] = twins()
    const { importer } = createImporter()
    const failing = vi.fn(async (attachment: ChatAttachment) => {
      if (attachment.url === first) throw new Error('refused')
      return importer(attachment)
    })
    const guard = new ChatInlineAttachmentGuard(failing)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      await expect(guard.importInlineImage(image(first))).resolves.toMatchObject({ url: first })
      // The failure of the first holds back neither the import nor the reuse of the second.
      const imported = await guard.importInlineImage(image(second))
      expect(imported.media).toMatchObject({ kind: 'managed' })
      // Other objects holding the same two images: matched by their whole content.
      const again = await guard.externalize({
        id: 'twins',
        title: 'Twins',
        messages: [{ role: 'user', content: '', attachments: [image(first), image(second)] }]
      })
      expect(again.session.messages[0].attachments?.[0]?.url).toBe(first)
      expect(again.session.messages[0].attachments?.[1]?.url).toBe(imported.url)
      expect(failing).toHaveBeenCalledTimes(2)
    } finally {
      warn.mockRestore()
    }
  })

  it('keeps no data: URL alive in its caches', async () => {
    const urls = Array.from({ length: 4 }, (_, index) => inlinePng(`cached-${index}`))
    const { importer } = createImporter()
    const guard = new ChatInlineAttachmentGuard(async (attachment) => {
      if (attachment.url === urls[3]) throw new Error('refused')
      return importer(attachment)
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      for (const url of urls) await guard.importInlineImage(image(url))
    } finally {
      warn.mockRestore()
    }
    const internals = guard as unknown as Record<string, Map<string, unknown>>
    const keys = ['recent', 'failures', 'inFlight'].flatMap((name) => [...internals[name].keys()])
    expect(keys.length).toBeGreaterThanOrEqual(4)
    expect(Math.max(...keys.map((key) => key.length))).toBeLessThan(64)
  })
})
