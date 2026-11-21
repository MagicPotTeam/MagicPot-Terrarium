import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatAttachment } from '@shared/api/svcLLMProxy'
import type { MediaReference } from '@shared/mediaReference'
import { installFakeIDBKeyRange } from '../../testUtils/fakeIdbKeyRange'
import { createFakeRestoredThreadIndexedDb } from '../../testUtils/fakeRestoredThreadIndexedDb'

// FIX-PLAN item 4, part 2: the open page migrates the legacy inline images of one stored
// conversation with one compare-and-update against the record its save baseline expects. Any
// failure leaves the stored record exactly as it was.

installFakeIDBKeyRange()

const media = vi.hoisted(() => ({
  migrateLegacyDataUrl: vi.fn(),
  reclaimLegacyMigration: vi.fn()
}))
vi.mock('../../utils/windowUtils', () => ({ api: () => ({ svcManagedMedia: media }) }))

const SCOPE = 'project-a.pane-1'
const inline = (seed: string, chars = 70 * 1024): string => {
  const prefix = 'data:image/png;base64,'
  const stem = btoa(seed.padEnd(24, '.'))
  return `${prefix}${stem}${'A'.repeat(chars - prefix.length - stem.length)}`
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

  it('leaves the record untouched and hands the imports back when one import fails', async () => {
    const storage = await import('./chatStorage')
    const { session, second } = legacySession()
    await storage.saveSessionToDB(session, SCOPE)
    const expected = (await readRecord(storage, 'legacy'))!
    const before = JSON.stringify(expected)
    const ok = media.migrateLegacyDataUrl.getMockImplementation()!
    media.migrateLegacyDataUrl.mockImplementation(async (request: { dataUrl: string }) => {
      if (request.dataUrl === second) throw new Error('disk full')
      return ok(request)
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      await expect(storage.migrateStoredSessionImages(expected, SCOPE)).resolves.toEqual({
        status: 'failed'
      })
    } finally {
      warn.mockRestore()
    }
    expect(JSON.stringify(await readRecord(storage, 'legacy'))).toBe(before)
    expect(media.reclaimLegacyMigration).toHaveBeenCalledTimes(1)
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
