import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatAttachment } from '@shared/api/svcLLMProxy'
import { installFakeIDBKeyRange } from '../../testUtils/fakeIdbKeyRange'
import { createFakeRestoredThreadIndexedDb } from '../../testUtils/fakeRestoredThreadIndexedDb'

// A stored form that has to wait (an import before the write) must not turn the page's own write
// into a permanent conflict when a reconcile writer moves the baseline meanwhile.

installFakeIDBKeyRange()
vi.mock('../../utils/windowUtils', () => ({ api: () => ({}) }))

const SCOPE = 'project-a.pane-1'
const inline = `data:image/png;base64,${'A'.repeat(70 * 1024)}`
const id = 'a'.repeat(64)
const managed: ChatAttachment = {
  type: 'image',
  url: `local-media:///managed/originals/aa/${id}.png`,
  media: {
    version: 1,
    kind: 'managed',
    relativePath: `originals/aa/${id}.png`,
    sha256: id,
    sizeBytes: 4096,
    mimeType: 'image/png',
    originalFileName: 'image.png'
  }
}

let fakeDb: ReturnType<typeof createFakeRestoredThreadIndexedDb>

beforeEach(() => {
  vi.resetModules()
  fakeDb = createFakeRestoredThreadIndexedDb()
  vi.stubGlobal('indexedDB', fakeDb.api)
  localStorage.clear()
})

afterEach(async () => {
  await fakeDb.state.database?.waitForTransactions()
  fakeDb.state.database?.close()
  vi.unstubAllGlobals()
})

describe('persistLatest with a stored form that waits', () => {
  it('is superseded, not a conflict, when the baseline moves while it waits', async () => {
    const storage = await import('./chatStorage')
    const { ChatSessionSaveBaseline } = await import('./chatSaveBaseline')
    type ChatSession = import('./chatStorage').ChatSession
    await storage.saveSessionToDB(
      {
        id: 's',
        title: 'T',
        messages: [{ role: 'user', content: 'hi', attachments: [{ type: 'image', url: inline }] }]
      },
      SCOPE
    )
    const loaded = (await storage.loadAllSessions(SCOPE)).find((session) => session.id === 's')!
    const baseline = new ChatSessionSaveBaseline()
    baseline.adoptLoaded(SCOPE, [loaded], new Set())
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => (release = resolve))
    const toStored = (session: ChatSession): ChatSession => ({
      ...session,
      messages: session.messages.map((message) =>
        message.attachments ? { ...message, attachments: [managed] } : message
      )
    })
    let waits = true
    baseline.setStoredForm({
      prepare: async (_scope, session) => {
        if (waits) await gate // the import of the inline image
        return toStored(session)
      },
      adopt: (_scope, _session, stored) => stored
    })
    let live: ChatSession = {
      ...loaded,
      messages: [...loaded.messages, { role: 'assistant', content: 'reply' }]
    }
    const save = baseline.persistLatest(
      SCOPE,
      's',
      () => live,
      () => loaded,
      undefined,
      true
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
    // The page's own reconcile writer (an attachment advance, a team reconcile) commits meanwhile.
    const committed = await storage.compareAndUpdateSessionInDB('s', SCOPE, {
      expectedSession: loaded,
      update: (session) => ({ ...session, title: 'renamed' })
    })
    expect(committed).toBeTruthy()
    baseline.advance(SCOPE, 's', committed!)
    live = { ...live, title: 'renamed' }
    release()

    const outcome = await save.then(
      () => 'saved',
      (error: Error) => error.name
    )
    expect(outcome).toBe('ChatSessionSaveSupersededError')

    // The caller's usual retry saves the live object against the moved baseline.
    waits = false
    const saved = await baseline.persistLatest(
      SCOPE,
      's',
      () => live,
      () => loaded,
      undefined,
      true
    )
    expect(saved).toBeTruthy()
    const stored = (await storage.loadAllSessions(SCOPE)).find((session) => session.id === 's')!
    expect(stored.title).toBe('renamed')
    expect(stored.messages.map((message) => message.content)).toEqual(['hi', 'reply'])
    expect(stored.messages[0].attachments?.[0]?.media).toMatchObject({ sha256: id })
  })
})
