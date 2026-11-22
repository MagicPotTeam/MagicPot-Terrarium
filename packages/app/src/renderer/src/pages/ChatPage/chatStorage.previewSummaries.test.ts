import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  POISONED_RECORD,
  createFakeChatIndexedDb,
  type FakeChatIndexedDb
} from '../../testUtils/fakeChatIndexedDb'

vi.mock('../../utils/windowUtils', () => ({ api: () => ({}) }))

const STORE = 'sessions-v2'
const PANE = 'project-a.agent-1'
const OTHER = 'project-a.agent-2'

const stored = (scope: string, id: string, extra: Record<string, unknown> = {}) => ({
  storageKey: `${scope}\u0000${id}`,
  storageScope: scope,
  id,
  title: `${scope}/${id}`,
  messages: [{ role: 'user', content: 'x'.repeat(64) }],
  ...extra
})

async function openStorage(db: FakeChatIndexedDb) {
  db.install(vi.stubGlobal)
  return import('./chatStorage')
}

describe('chatStorage thread list support', () => {
  let db: FakeChatIndexedDb

  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
    localStorage.clear()
    db = createFakeChatIndexedDb()
    db.setVersion(2)
    db.seedStore(STORE, 'storageKey', [])
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    localStorage.clear()
  })

  describe('loadSessionPreviewSummaries', () => {
    it('returns only the thread list fields of one scope, in creation order', async () => {
      db.seedStore(STORE, 'storageKey', [
        stored(PANE, 'lead', { title: 'Lead', createdAt: 20, teamSettings: { maxMembers: 6 } }),
        stored(PANE, 'member', {
          title: 'Member',
          createdAt: 30,
          teamLeadId: 'lead',
          teamMemberName: 'writer'
        }),
        stored(PANE, 'archived', {
          title: 'Old',
          createdAt: 10,
          archived: true,
          draft: { inputValue: 'draft' }
        }),
        stored(PANE, 'undated', { title: 'No date' }),
        stored(OTHER, 'other-pane', { title: 'Other pane' })
      ])
      db.seedRows(STORE, [
        { key: 'project-0.agent-1\u0000old', value: POISONED_RECORD },
        { key: `${PANE}0\u0000neighbour`, value: POISONED_RECORD },
        { key: 'project-z.agent-1\u0000old', value: POISONED_RECORD }
      ])
      const storage = await openStorage(db)

      const summaries = await storage.loadSessionPreviewSummaries(PANE)

      expect(summaries).toEqual([
        { id: 'undated', title: 'No date' },
        { id: 'archived', title: 'Old', createdAt: 10, archived: true },
        { id: 'lead', title: 'Lead', createdAt: 20 },
        { id: 'member', title: 'Member', createdAt: 30, teamLeadId: 'lead' }
      ])
      // Same conversations and order as the full reader.
      expect(summaries.map((summary) => summary.id)).toEqual(
        (await storage.loadAllSessions(PANE)).map((session) => session.id)
      )
      expect(db.stats.poisonedReads).toBe(0)
      expect(db.stats.unrangedValueScans).toBe(0)
    })

    it('walks the scope with a cursor and writes nothing', async () => {
      db.seedStore(STORE, 'storageKey', [
        stored(PANE, 'a'),
        // loadAllSessions repairs a queued receipt with a write; the summary reader must not.
        stored(PANE, 'b', {
          teamMessageReceipts: [
            { id: 'r1', teamKey: 'team', state: 'queued', createdAt: 1, updatedAt: 1 }
          ]
        }),
        stored(OTHER, 'c')
      ])
      const storage = await openStorage(db)
      const before = structuredClone(db.values(STORE))

      await storage.loadSessionPreviewSummaries(PANE)

      expect(db.stats.calls.openCursor).toBe(1)
      expect(db.stats.calls.getAll).toBe(0)
      expect(db.stats.calls.put).toBe(0)
      expect(db.stats.handedOut).toEqual([`${PANE}\u0000a`, `${PANE}\u0000b`])
      expect(db.values(STORE)).toEqual(before)
      expect(storage.getChatScopeRevision(PANE)).toBe(0)
    })

    it('includes a record stored under a key without the scope prefix', async () => {
      db.seedStore(STORE, 'storageKey', [stored(PANE, 'regular', { createdAt: 1 })])
      db.seedRows(STORE, [
        {
          key: 'stray-key',
          value: { ...stored(PANE, 'stray', { createdAt: 1 }), storageKey: 'stray-key' }
        },
        { key: 'other-stray', value: { ...stored(OTHER, 'elsewhere'), storageKey: 'other-stray' } }
      ])
      const storage = await openStorage(db)

      expect(
        (await storage.loadSessionPreviewSummaries(PANE)).map((summary) => summary.id)
      ).toEqual((await storage.loadAllSessions(PANE)).map((session) => session.id))
      expect(
        (await storage.loadSessionPreviewSummaries(PANE)).map((summary) => summary.id)
      ).toEqual(['regular', 'stray'])
    })

    it('rejects instead of returning a partial list when a record cannot be read', async () => {
      db.seedStore(STORE, 'storageKey', [stored(PANE, 'fine')])
      db.seedRows(STORE, [{ key: `${PANE}\u0000broken`, value: POISONED_RECORD }])
      const storage = await openStorage(db)
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)

      await expect(storage.loadSessionPreviewSummaries(PANE)).rejects.toThrow()
      consoleError.mockRestore()
    })
  })

  describe('summaries kept current by the writers', () => {
    const ids = (summaries: Array<{ id: string }>) => summaries.map((summary) => summary.id)

    it('answers later calls without touching the store and matches a fresh read after every write', async () => {
      db.seedStore(STORE, 'storageKey', [
        stored(PANE, 'first', { title: 'First', createdAt: 10 }),
        stored(OTHER, 'other', { title: 'Other pane', createdAt: 5 })
      ])
      const storage = await openStorage(db)
      expect(await storage.loadSessionPreviewSummaries(PANE)).toEqual([
        { id: 'first', title: 'First', createdAt: 10 }
      ])
      expect(db.stats.calls.openCursor).toBe(1)
      const readsBefore = db.stats.handedOut.length

      // A new conversation, saved the way the page saves it.
      const second = { id: 'second', title: 'Second', messages: [], createdAt: 20 }
      await storage.saveSessionToDB(second, PANE, { expectedSession: null })
      expect(await storage.loadSessionPreviewSummaries(PANE)).toEqual([
        { id: 'first', title: 'First', createdAt: 10 },
        { id: 'second', title: 'Second', createdAt: 20 }
      ])

      // A rename through compare-and-update, and an archive through a guarded save.
      await storage.compareAndUpdateSessionInDB('second', PANE, {
        expectedSession: second,
        update: (current) => ({ ...current, title: 'Second, renamed' })
      })
      const first = (await storage.loadSessionFromDB('first', PANE))!
      await storage.saveSessionToDB({ ...first, archived: true }, PANE, { expectedSession: first })
      expect(await storage.loadSessionPreviewSummaries(PANE)).toEqual([
        { id: 'first', title: 'First', createdAt: 10, archived: true },
        { id: 'second', title: 'Second, renamed', createdAt: 20 }
      ])

      // A rejected save changes nothing.
      await expect(
        storage.saveSessionToDB({ ...second, title: 'Stale writer' }, PANE, {
          expectedSession: second
        })
      ).rejects.toThrow('changed in another writer')
      // A write to another scope does not concern this one.
      await storage.saveSessionToDB({ id: 'elsewhere', title: 'Elsewhere', messages: [] }, OTHER)
      expect(ids(await storage.loadSessionPreviewSummaries(PANE))).toEqual(['first', 'second'])
      expect((await storage.loadSessionPreviewSummaries(PANE))[1].title).toBe('Second, renamed')

      await storage.deleteSessionFromDB('first', PANE)
      const fromMemory = await storage.loadSessionPreviewSummaries(PANE)
      expect(fromMemory).toEqual([{ id: 'second', title: 'Second, renamed', createdAt: 20 }])

      // None of the summary calls above walked the store again ...
      expect(db.stats.calls.openCursor).toBe(1)
      expect(
        db.stats.handedOut.slice(readsBefore).every((key) => key !== `${OTHER}\u0000other`)
      ).toBe(true)
      // ... and a walk of the store gives the same answer.
      expect(await storage.loadSessionPreviewSummaries(PANE, { fresh: true })).toEqual(fromMemory)
      expect(db.stats.calls.openCursor).toBe(2)
      expect(ids(await storage.loadAllSessions(PANE))).toEqual(ids(fromMemory))
    })

    it('goes back to the store after a write it has no record list for', async () => {
      const storage = await openStorage(db)
      const lead = {
        id: 'lead',
        title: 'Lead',
        messages: [],
        createdAt: 1,
        teamSettings: { maxMembers: 6, defaultModel: null, autoCleanup: true }
      }
      await storage.saveSessionToDB(lead, PANE)
      expect(ids(await storage.loadSessionPreviewSummaries(PANE))).toEqual(['lead'])
      expect(db.stats.calls.openCursor).toBe(1)

      const member = {
        id: 'member',
        title: 'Member',
        messages: [],
        createdAt: 2,
        teamLeadId: 'lead',
        teamMemberName: 'writer'
      }
      await storage.createTeamMemberInDB({ scope: PANE, expectedLead: lead, member })
      expect(await storage.loadSessionPreviewSummaries(PANE)).toEqual([
        { id: 'lead', title: 'Lead', createdAt: 1 },
        { id: 'member', title: 'Member', createdAt: 2, teamLeadId: 'lead' }
      ])
      expect(db.stats.calls.openCursor).toBe(2)

      await storage.endTeamInDB({ scope: PANE, expectedLead: lead })
      expect(await storage.loadSessionPreviewSummaries(PANE)).toEqual([
        { id: 'lead', title: 'Lead', createdAt: 1 },
        { id: 'member', title: 'Member', createdAt: 2, teamLeadId: 'lead', archived: true }
      ])
      expect(db.stats.calls.openCursor).toBe(3)

      await storage.saveAllSessions([{ id: 'bulk', title: 'Bulk', messages: [] }], 'bulk-scope')
      expect(ids(await storage.loadSessionPreviewSummaries('bulk-scope'))).toEqual(['bulk'])
      await storage.saveAllSessions([{ id: 'bulk-2', title: 'Bulk 2', messages: [] }], 'bulk-scope')
      expect(ids(await storage.loadSessionPreviewSummaries('bulk-scope'))).toEqual(['bulk-2'])
    })

    it('does not keep the result of a walk that a save overtook', async () => {
      db.seedStore(STORE, 'storageKey', [
        stored(PANE, 'session', { title: 'Before', createdAt: 1 })
      ])
      const storage = await openStorage(db)
      const session = (await storage.loadSessionFromDB('session', PANE))!

      const walk = storage.loadSessionPreviewSummaries(PANE)
      const save = storage.saveSessionToDB({ ...session, title: 'After' }, PANE, {
        expectedSession: session
      })
      await Promise.all([walk, save])

      // Whatever the walk saw, the next answer is the saved state.
      expect(await storage.loadSessionPreviewSummaries(PANE)).toEqual([
        { id: 'session', title: 'After', createdAt: 1 }
      ])
      expect(await storage.loadSessionPreviewSummaries(PANE, { fresh: true })).toEqual([
        { id: 'session', title: 'After', createdAt: 1 }
      ])
    })
  })

  describe('getChatScopeRevision', () => {
    it('moves for the written scope after every kind of committed write and never for a read', async () => {
      db.seedStore(STORE, 'storageKey', [stored(OTHER, 'untouched')])
      const storage = await openStorage(db)
      const revision = () => storage.getChatScopeRevision(PANE)
      const expectMoved = (previous: number): number => {
        expect(revision()).toBeGreaterThan(previous)
        return revision()
      }
      expect(revision()).toBe(0)

      await storage.loadAllSessions(PANE)
      await storage.loadSessionPreviewSummaries(PANE)
      await storage.loadSessionFromDB('missing', PANE)
      expect(revision()).toBe(0)

      const lead = {
        id: 'lead',
        title: 'Lead',
        messages: [],
        teamSettings: { maxMembers: 6, defaultModel: null, autoCleanup: true }
      }
      await storage.saveSessionToDB(lead, PANE)
      let seen = expectMoved(0)

      const renamed = await storage.compareAndUpdateSessionInDB('lead', PANE, {
        expectedSession: lead,
        update: (current) => ({ ...current, title: 'Lead, renamed' })
      })
      expect(renamed?.title).toBe('Lead, renamed')
      seen = expectMoved(seen)

      const member = {
        id: 'member',
        title: 'Member',
        messages: [],
        teamLeadId: 'lead',
        teamMemberName: 'writer'
      }
      const admitted = await storage.createTeamMemberInDB({
        scope: PANE,
        expectedLead: renamed!,
        member
      })
      seen = expectMoved(seen)

      await storage.setTeamMemberModelChoiceInDB({
        scope: PANE,
        expectedLead: renamed!,
        expectedMember: admitted.member,
        profileId: 'profile-1'
      })
      seen = expectMoved(seen)

      await storage.endTeamInDB({ scope: PANE, expectedLead: renamed! })
      seen = expectMoved(seen)

      await storage.deleteSessionFromDB('member', PANE)
      seen = expectMoved(seen)

      // Another scope, the default scope and the bulk writer each move their own marker only.
      expect(storage.getChatScopeRevision(OTHER)).toBe(0)
      expect(storage.getChatScopeRevision()).toBe(0)
      await storage.saveAllSessions([{ id: 'bulk', title: 'Bulk', messages: [] }], 'bulk-scope')
      expect(storage.getChatScopeRevision('bulk-scope')).toBe(1)
      await storage.saveSessionToDB({ id: 'd', title: 'Default', messages: [] })
      expect(storage.getChatScopeRevision()).toBe(1)
      expect(storage.getChatScopeRevision('')).toBe(1)
      expect(storage.getChatScopeRevision(OTHER)).toBe(0)
      expect(revision()).toBe(seen)
    })

    it('has moved by the time a save resolves, so a refresh triggered by the save reads fresh data', async () => {
      const storage = await openStorage(db)
      const session = { id: 's', title: 'First title', messages: [] }
      await storage.saveSessionToDB(session, PANE)
      const cachedAt = storage.getChatScopeRevision(PANE)
      expect(await storage.loadSessionPreviewSummaries(PANE)).toEqual([
        { id: 's', title: 'First title' }
      ])

      await storage.saveSessionToDB({ ...session, title: 'Second title' }, PANE, {
        expectedSession: session
      })

      expect(storage.getChatScopeRevision(PANE)).not.toBe(cachedAt)
      expect(await storage.loadSessionPreviewSummaries(PANE)).toEqual([
        { id: 's', title: 'Second title' }
      ])
    })

    it('moves after the debounced autosave writes', async () => {
      const storage = await openStorage(db)
      const saved = new Promise<void>((resolve, reject) => {
        storage.debouncedSaveSessions([{ id: 'auto', title: 'Autosaved', messages: [] }], 5, PANE, {
          onSuccess: () => resolve(),
          onError: (error) => reject(error)
        })
      })
      expect(storage.getChatScopeRevision(PANE)).toBe(0)
      await saved
      expect(storage.getChatScopeRevision(PANE)).toBe(1)
    })

    it('moves for the default scope when localStorage conversations are migrated', async () => {
      localStorage.setItem(
        'chat.sessions',
        JSON.stringify([{ id: 'from-local-storage', title: 'Migrated', messages: [] }])
      )
      const storage = await openStorage(db)

      const migrated = await storage.migrateFromLocalStorage()

      expect(migrated?.map((session) => session.id)).toEqual(['from-local-storage'])
      expect(storage.getChatScopeRevision('default')).toBe(1)
    })
  })
})
