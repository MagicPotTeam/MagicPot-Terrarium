import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatAttachment } from '@shared/api/svcLLMProxy'
import type { MediaReference } from '@shared/mediaReference'
import type { LegacyAttachmentReplacement } from './chatStorage'
import { installFakeIDBKeyRange } from '../../testUtils/fakeIdbKeyRange'
import { createFakeRestoredThreadIndexedDb } from '../../testUtils/fakeRestoredThreadIndexedDb'

// FIX-PLAN item 4, part 2: the open page migrates the legacy inline images of one stored
// conversation with one compare-and-update against the record its save baseline expects. An image
// main cannot import stays inline and the others are still migrated; a failed write leaves the
// stored record exactly as it was.

installFakeIDBKeyRange()

const media = vi.hoisted(() => ({
  migrateLegacyDataUrl: vi.fn(),
  reclaimLegacyMigration: vi.fn()
}))
vi.mock('../../utils/windowUtils', () => ({ api: () => ({ svcManagedMedia: media }) }))

const SCOPE = 'project-a.pane-1'
const inline = (seed: string, chars = 70 * 1024, type = 'png'): string => {
  const prefix = `data:image/${type};base64,`
  const stem = btoa(seed.padEnd(24, '.'))
  const fill = chars - prefix.length - stem.length
  // Strict base64, as main requires: a payload length divisible by four.
  return `${prefix}${stem}${'A'.repeat(fill - ((stem.length + fill) % 4))}`
}
const image = (url: string, fileName = 'image.png'): ChatAttachment => ({
  type: 'image',
  url,
  fileName
})
const referenceFor = (dataUrl: string): MediaReference => {
  let hash = 7
  for (let index = 0; index < dataUrl.length; index += index < 256 ? 1 : 101)
    hash = (hash * 31 + dataUrl.charCodeAt(index)) >>> 0
  const id = hash.toString(16).padStart(8, '0').repeat(8)
  return {
    version: 1,
    kind: 'managed',
    sha256: id,
    relativePath: `originals/${id.slice(0, 2)}/${id}.png`,
    sizeBytes: 1024,
    mimeType: 'image/png',
    originalFileName: 'image.png'
  }
}

let fakeDb: ReturnType<typeof createFakeRestoredThreadIndexedDb>

beforeEach(() => {
  vi.resetModules()
  media.migrateLegacyDataUrl.mockReset()
  media.reclaimLegacyMigration.mockReset()
  media.reclaimLegacyMigration.mockResolvedValue({ queued: true })
  media.migrateLegacyDataUrl.mockImplementation(async (request: { dataUrl: string }) => {
    const reference = referenceFor(request.dataUrl)
    return {
      reference,
      localMediaUrl: `local-media:///managed/${reference.relativePath}`,
      checkpoint: { version: 1, reclaim: { reference } }
    }
  })
  fakeDb = createFakeRestoredThreadIndexedDb()
  vi.stubGlobal('indexedDB', fakeDb.api)
  localStorage.clear()
})

afterEach(async () => {
  await fakeDb.state.database?.waitForTransactions()
  fakeDb.state.database?.close()
  vi.unstubAllGlobals()
})

const legacySession = () => {
  const first = inline('first')
  const second = inline('second')
  return {
    first,
    second,
    session: {
      id: 'legacy',
      title: 'Legacy',
      teamGeneration: 2,
      messages: [
        { role: 'user' as const, content: 'look', attachments: [image(first), image(second)] },
        { role: 'assistant' as const, content: 'answer' }
      ],
      compactedMessages: [{ role: 'user' as const, content: 'old', attachments: [image(first)] }],
      draft: {
        inputValue: 'draft text',
        pendingAttachments: [image(inline('draft', 2048))],
        pendingHiddenContext: '',
        updatedAt: 5
      }
    }
  }
}

const readRecord = async (storage: typeof import('./chatStorage'), id: string) =>
  (await storage.loadAllSessions(SCOPE)).find((session) => session.id === id)

describe('migrateStoredSessionImages', () => {
  it('replaces every legacy inline image in one write, and costs one check afterwards', async () => {
    const storage = await import('./chatStorage')
    const { session, first, second } = legacySession()
    await storage.saveSessionToDB(session, SCOPE)
    const expected = (await readRecord(storage, 'legacy'))!
    expect(storage.sessionNeedsLegacyAttachmentMigration(expected)).toBe(true)

    const result = await storage.migrateStoredSessionImages(expected, SCOPE)

    expect(result.status).toBe('migrated')
    // The same image held twice (message and compacted copy) is imported once.
    expect(media.migrateLegacyDataUrl).toHaveBeenCalledTimes(3)
    // Into the user-owned namespace, which managed-media cleanup never deletes from: an import
    // whose record is not written yet cannot lose its file.
    for (const [request] of media.migrateLegacyDataUrl.mock.calls) {
      expect(request).toMatchObject({
        storage: { namespace: 'user-output', scope: 'chat-attachments' }
      })
    }
    const stored = (await readRecord(storage, 'legacy'))!
    expect(JSON.stringify(stored)).not.toContain('data:image')
    expect(JSON.stringify(stored).length).toBeLessThan(50_000)
    expect(stored).toEqual(result.status === 'migrated' ? result.session : undefined)
    // Nothing lost, duplicated or reordered; every other field kept.
    expect(stored.messages.map((message) => message.content)).toEqual(['look', 'answer'])
    expect(referenceFor(first).sha256).not.toBe(referenceFor(second).sha256)
    expect(stored.messages[0].attachments?.map((attachment) => attachment.media?.sha256)).toEqual([
      referenceFor(first).sha256,
      referenceFor(second).sha256
    ])
    expect(stored.compactedMessages?.[0].attachments?.[0]?.media).toEqual(referenceFor(first))
    expect(stored.draft).toMatchObject({ inputValue: 'draft text', updatedAt: 5 })
    expect(stored.teamGeneration).toBe(2)
    if (result.status === 'migrated') {
      expect(result.replacements.get(first)?.url).toBe(stored.messages[0].attachments?.[0]?.url)
    }

    // Idempotent: a migrated record needs no work and is not written again.
    expect(storage.sessionNeedsLegacyAttachmentMigration(stored)).toBe(false)
    const storedText = JSON.stringify(stored)
    await expect(storage.migrateStoredSessionImages(stored, SCOPE)).resolves.toEqual({
      status: 'unchanged'
    })
    expect(media.migrateLegacyDataUrl).toHaveBeenCalledTimes(3)
    expect(JSON.stringify(await readRecord(storage, 'legacy'))).toBe(storedText)
    expect(media.reclaimLegacyMigration).not.toHaveBeenCalled()
  })

  it('keeps an image whose import fails inline and still migrates the others', async () => {
    const storage = await import('./chatStorage')
    const { session, first, second } = legacySession()
    await storage.saveSessionToDB(session, SCOPE)
    const expected = (await readRecord(storage, 'legacy'))!
    const ok = media.migrateLegacyDataUrl.getMockImplementation()!
    media.migrateLegacyDataUrl.mockImplementation(async (request: { dataUrl: string }) => {
      if (request.dataUrl === second) throw new Error('disk full')
      return ok(request)
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    let result: Awaited<ReturnType<typeof storage.migrateStoredSessionImages>>
    try {
      result = await storage.migrateStoredSessionImages(expected, SCOPE)
    } finally {
      warn.mockRestore()
    }
    expect(result.status).toBe('migrated')
    const stored = (await readRecord(storage, 'legacy'))!
    expect(stored.messages[0].attachments?.map((attachment) => attachment.url)).toEqual([
      `local-media:///managed/${referenceFor(first).relativePath}`,
      second
    ])
    expect(stored.messages[0].attachments?.[1]?.media).toBeUndefined()
    expect(stored.compactedMessages?.[0].attachments?.[0]?.media).toEqual(referenceFor(first))
    expect(stored.draft?.pendingAttachments[0]?.media).toBeTruthy()
    expect(media.reclaimLegacyMigration).not.toHaveBeenCalled()
    // The image kept inline is tried again at a later start.
    expect(storage.sessionNeedsLegacyAttachmentMigration(stored)).toBe(true)
  })

  it('imports before it writes, and keeps an image whose import does not finish in time inline', async () => {
    const storage = await import('./chatStorage')
    const { session, first, second } = legacySession()
    await storage.saveSessionToDB(session, SCOPE)
    const expected = (await readRecord(storage, 'legacy'))!
    const ok = media.migrateLegacyDataUrl.getMockImplementation()!
    media.migrateLegacyDataUrl.mockImplementation((request: { dataUrl: string }) =>
      request.dataUrl === second ? new Promise(() => undefined) : ok(request)
    )
    const write = vi.fn(async (replacements: ReadonlyMap<string, LegacyAttachmentReplacement>) => {
      // Called once every import has settled, with what each imported image becomes.
      expect(media.migrateLegacyDataUrl).toHaveBeenCalledTimes(3)
      expect([...replacements.keys()]).not.toContain(second)
      return storage.compareAndUpdateSessionInDB('legacy', SCOPE, {
        expectedSession: expected,
        update: (current) => storage.applyLegacyAttachmentReplacements(current, replacements)
      })
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    let result: Awaited<ReturnType<typeof storage.migrateStoredSessionImages>>
    try {
      result = await storage.migrateStoredSessionImages(expected, SCOPE, {
        importTimeoutMs: 30,
        write
      })
    } finally {
      warn.mockRestore()
    }
    expect(result.status).toBe('migrated')
    expect(write).toHaveBeenCalledTimes(1)
    const stored = (await readRecord(storage, 'legacy'))!
    expect(stored.messages[0].attachments?.map((attachment) => attachment.url)).toEqual([
      `local-media:///managed/${referenceFor(first).relativePath}`,
      second
    ])
    expect(stored.messages.map((message) => message.content)).toEqual(['look', 'answer'])
    expect(stored.draft?.pendingAttachments[0]?.media).toBeTruthy()
  })

  it('leaves the record untouched when no image could be imported', async () => {
    const storage = await import('./chatStorage')
    const { session } = legacySession()
    await storage.saveSessionToDB(session, SCOPE)
    const expected = (await readRecord(storage, 'legacy'))!
    const before = JSON.stringify(expected)
    media.migrateLegacyDataUrl.mockRejectedValue(new Error('main is gone'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      await expect(storage.migrateStoredSessionImages(expected, SCOPE)).resolves.toEqual({
        status: 'failed'
      })
    } finally {
      warn.mockRestore()
    }
    expect(JSON.stringify(await readRecord(storage, 'legacy'))).toBe(before)
  })

  it('migrates the images main can import and leaves the others inline, unsent', async () => {
    const storage = await import('./chatStorage')
    const pngs = Array.from({ length: 8 }, (_, index) => inline(`png-${index}`))
    const jpg = inline('jpg', 70 * 1024, 'jpg')
    const bmp = inline('bmp', 70 * 1024, 'bmp')
    const svg = `data:image/svg+xml;base64,${btoa('<svg xmlns="http://www.w3.org/2000/svg"/>')}`
    // Line breaks in the payload (an old MIME-style encoder): not strict base64.
    const wrapped = (() => {
      const valid = inline('wrapped')
      const cut = 'data:image/png;base64,'.length + 76
      return `${valid.slice(0, cut)}\r\n${valid.slice(cut, -2)}`
    })()
    const unpadded = inline('unpadded').slice(0, -1)
    const attachments = [...pngs, jpg, bmp, svg, wrapped, unpadded].map((url) => image(url))
    await storage.saveSessionToDB(
      {
        id: 'mixed',
        title: 'Mixed',
        messages: [{ role: 'user', content: 'all of them', attachments }]
      },
      SCOPE
    )
    const expected = (await readRecord(storage, 'mixed'))!
    const result = await storage.migrateStoredSessionImages(expected, SCOPE)

    expect(result.status).toBe('migrated')
    const sent = media.migrateLegacyDataUrl.mock.calls.map(
      ([request]) => (request as { dataUrl: string }).dataUrl
    )
    // Only what main accepts is sent; image/jpg goes as image/jpeg, with the same payload.
    expect(sent).toEqual([...pngs, `data:image/jpeg;base64,${jpg.slice(jpg.indexOf(',') + 1)}`])
    const stored = (await readRecord(storage, 'mixed'))!
    const urls = stored.messages[0].attachments!.map((attachment) => attachment.url)
    expect(urls.slice(0, 9).every((url) => url.startsWith('local-media:'))).toBe(true)
    expect(urls.slice(9)).toEqual([bmp, svg, wrapped, unpadded])
    expect(stored.messages[0].attachments).toHaveLength(13)
  })

  it('never writes over a record that is not the expected one', async () => {
    const storage = await import('./chatStorage')
    const { session } = legacySession()
    await storage.saveSessionToDB(session, SCOPE)
    const expected = (await readRecord(storage, 'legacy'))!
    // Another writer (another window) changed the record after this page read it.
    const newer = { ...expected, title: 'Renamed elsewhere' }
    await storage.saveSessionToDB(newer, SCOPE)

    await expect(storage.migrateStoredSessionImages(expected, SCOPE)).resolves.toEqual({
      status: 'not-written'
    })
    expect((await readRecord(storage, 'legacy'))?.title).toBe('Renamed elsewhere')
    expect(JSON.stringify(await readRecord(storage, 'legacy'))).toContain('data:image')
    expect(media.reclaimLegacyMigration).toHaveBeenCalled()

    // The page's own condition, checked inside the write, can refuse it too.
    media.reclaimLegacyMigration.mockClear()
    const current = (await readRecord(storage, 'legacy'))!
    await expect(
      storage.migrateStoredSessionImages(current, SCOPE, { shouldUpdate: () => false })
    ).resolves.toEqual({ status: 'not-written' })
    expect(JSON.stringify(await readRecord(storage, 'legacy'))).toBe(JSON.stringify(current))
  })

  it('runs one migration of a conversation at a time', async () => {
    const storage = await import('./chatStorage')
    const { session } = legacySession()
    await storage.saveSessionToDB(session, SCOPE)
    const expected = (await readRecord(storage, 'legacy'))!
    const first = storage.migrateStoredSessionImages(expected, SCOPE)
    await expect(storage.migrateStoredSessionImages(expected, SCOPE)).resolves.toEqual({
      status: 'busy'
    })
    await expect(first).resolves.toMatchObject({ status: 'migrated' })
  })
})

describe('ChatSessionSaveBaseline.rewriteStored', () => {
  it('makes the rewritten record the baseline, so later saves are not conflicts', async () => {
    const storage = await import('./chatStorage')
    const { ChatSessionSaveBaseline } = await import('./chatSaveBaseline')
    const { session } = legacySession()
    await storage.saveSessionToDB(session, SCOPE)
    const loaded = (await readRecord(storage, 'legacy'))!
    const baseline = new ChatSessionSaveBaseline()
    baseline.adoptLoaded(SCOPE, [loaded], new Set())

    let live = loaded
    // A save asked for while the rewrite runs waits for it and compares with its result.
    const rewrite = baseline.rewriteStored(
      SCOPE,
      'legacy',
      () => loaded,
      async (expected) => {
        const result = await storage.migrateStoredSessionImages(expected, SCOPE)
        if (result.status !== 'migrated') return null
        live = result.session
        return result.session
      }
    )
    const queuedSave = baseline.persistLatest(
      SCOPE,
      'legacy',
      () => live,
      () => loaded
    )
    const migrated = await rewrite
    expect(migrated).toBeTruthy()
    await expect(queuedSave).resolves.toBe(live)

    live = { ...live, title: 'Edited after the migration' }
    await expect(
      baseline.persistLatest(
        SCOPE,
        'legacy',
        () => live,
        () => loaded
      )
    ).resolves.toBe(live)
    const stored = (await readRecord(storage, 'legacy'))!
    expect(stored.title).toBe('Edited after the migration')
    expect(JSON.stringify(stored)).not.toContain('data:image')
  })

  it('writes nothing without a baseline record', async () => {
    const { ChatSessionSaveBaseline } = await import('./chatSaveBaseline')
    const baseline = new ChatSessionSaveBaseline()
    const write = vi.fn()
    await expect(baseline.rewriteStored(SCOPE, 'unknown', () => null, write)).resolves.toBeNull()
    expect(write).not.toHaveBeenCalled()
  })
})
